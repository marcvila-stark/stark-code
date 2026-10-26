/** Resolve only an installed Python launcher; never fall back to a different Python environment. */
export function claudeSwapPythonInterpreter(launcher: string): string | null {
  const firstLine = launcher.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const interpreter = firstLine.startsWith("#!") ? firstLine.slice(2).trim() : "";
  return /^\/[^\r\n]*\/python(?:\d+(?:\.\d+)*)?$/.test(interpreter) ? interpreter : null;
}

/**
 * cswap's list uses .claude.json identity, which a still-running Claude process can
 * overwrite after a switch. Compare credential lineages inside cswap's interpreter
 * instead. If a live CLI has rotated its token beyond the saved lineage, ask the
 * authenticated profile endpoint once. Only allowlisted identity leaves this
 * process; no tokens or fingerprints. The caller caches results for 60 seconds.
 * Construct the read-only storage leaf, not the switcher (whose constructor migrates).
 */
export const CLAUDE_ACCOUNT_IDENTITY_SCRIPT = String.raw`
import json, logging, sys
from types import SimpleNamespace

def identify():
    from claude_swap.credentials import CredentialStore
    from claude_swap.models import Platform
    from claude_swap.oauth import credential_fingerprint, extract_oauth_data
    from claude_swap.paths import get_backup_root

    accounts = json.loads(sys.argv[1])
    if not isinstance(accounts, list) or len(accounts) > 1000:
        return None
    backup_root = get_backup_root()
    def roster_matches():
        roster = json.loads((backup_root / "sequence.json").read_text(encoding="utf-8"))
        saved = roster.get("accounts", {})
        return all(
            isinstance(account, dict) and type(account.get("number")) is int
            and account["number"] > 0 and isinstance(account.get("email"), str)
            and isinstance(account.get("organizationUuid"), (str, type(None)))
            and saved.get(str(account["number"]), {}).get("email") == account["email"]
            and (saved.get(str(account["number"]), {}).get("organizationUuid") or None)
                == (account["organizationUuid"] or None)
            for account in accounts
        )
    if not roster_matches():
        return None
    logger = logging.getLogger("stark-code-identity")
    logger.disabled = True
    store = CredentialStore(SimpleNamespace(
        platform=Platform.detect(), credentials_dir=backup_root / "credentials",
        _logger=logger,
    ))
    active = store._read_active_credentials()
    if not active.value or active.keychain_unavailable or active.degraded:
        return None
    fingerprint = credential_fingerprint(active.value)
    if not fingerprint:
        return None
    matches = []
    for account in accounts:
        if (not isinstance(account, dict) or type(account.get("number")) is not int
            or account["number"] <= 0 or not isinstance(account.get("email"), str)
            or not isinstance(account.get("organizationUuid"), (str, type(None)))):
            return None
        backup, unreadable = store._read_account_credentials_ex(str(account["number"]), account["email"])
        if unreadable:
            return None
        if backup and credential_fingerprint(backup) == fingerprint:
            matches.append({key: account[key] for key in ("number", "email", "organizationUuid")})
    if not matches:
        # A profile GET reads identity only: no refresh, model call or login write.
        # Never follow a redirect with the bearer token or accept an unbounded body.
        import urllib.request
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        oauth = extract_oauth_data(active.value)
        token = oauth.get("accessToken") if isinstance(oauth, dict) else None
        if not isinstance(token, str) or not token:
            return None
        request = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/profile",
            headers={"Authorization": "Bearer " + token, "User-Agent": "Stark-Code/1.0"},
            method="GET",
        )
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
            if response.status != 200:
                return None
            body = response.read(65_537)
            if len(body) > 65_536:
                return None
            profile = json.loads(body)
        person = profile.get("account") if isinstance(profile, dict) else None
        organization = profile.get("organization") if isinstance(profile, dict) else None
        if (not isinstance(person, dict) or not isinstance(organization, dict)
            or not isinstance(person.get("uuid"), str) or not person["uuid"].strip()
            or not isinstance(person.get("email"), str) or not person["email"].strip()
            or not isinstance(organization.get("uuid"), str) or not organization["uuid"].strip()):
            return None
        matches = [
            {key: account[key] for key in ("number", "email", "organizationUuid")}
            for account in accounts
            if account["email"] == person["email"] and account["organizationUuid"] == organization["uuid"]
        ]
    after = store._read_active_credentials()
    if (not after.value or after.keychain_unavailable or after.degraded
        or credential_fingerprint(after.value) != fingerprint or not roster_matches()):
        return None
    return matches[0] if len(matches) == 1 else None

try:
    identity = identify()
except Exception:
    identity = None
print(json.dumps({"schemaVersion": 1, "identity": identity}))
`;
