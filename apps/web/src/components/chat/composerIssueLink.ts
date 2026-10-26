export interface ComposerIssueLink {
  readonly url: string;
  readonly repository: string;
  readonly number: number;
  readonly label: string;
  readonly markdown: string;
}

/** Validates a reference only. Reading private issue contents belongs to the provider's tools. */
export function parseComposerIssueLink(
  input: string,
  allowedHosts: readonly string[] = ["github.com"],
): ComposerIssueLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !allowedHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase())
  ) {
    return null;
  }
  const match = /^\/([a-z\d][a-z\d-]*)\/([a-z\d_.-]+)\/issues\/([1-9]\d*)\/?$/i.exec(url.pathname);
  if (!match) return null;
  const [, owner, repo, issue] = match;
  if (!owner || !repo || !issue || repo === "." || repo === "..") return null;
  const number = Number(issue);
  if (!Number.isSafeInteger(number)) return null;
  const repository = `${owner}/${repo}`;
  const canonicalUrl = `https://${url.hostname}/${repository}/issues/${number}`;
  const label = `${repository}#${number}`;
  return {
    url: canonicalUrl,
    repository,
    number,
    label,
    markdown: `[${label}](${canonicalUrl})`,
  };
}
