import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatResetsIn,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
} from "@starkfuture/shared/usageLimits";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@starkfuture/contracts";

import { ensureLocalApi } from "../../localApi";
import { claudeAccountsEnvironment } from "../../state/claudeAccounts";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isSharedClaudeOrganizationContext,
  sharedClaudeOrganizationName,
} from "../../claudeSharedLogin";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PaceIcon, ResetCreditDialog, resetCreditsSummary, useResetCredit } from "./UsageLimits";

/** `someone@example.com` → `SE`: enough to tell accounts apart, too little to identify one. */
function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

/** A stable hue per email, so the same account gets the same chip on every visit. */
function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** The two-letter chip for an email, coloured by a stable hue per address. */
function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

/**
 * The same mark the model picker uses for a native instance (provider glyph,
 * initials badge, accent); hub accounts have no instance, so they get the chip.
 */
function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          providerClients.get(account.driver)?.label ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

/**
 * Who an account is, without printing the email: the instance name when there
 * is one, else a two-letter chip. The address itself is revealed on demand in
 * the segment's popover.
 */
function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Everything about one account in one window: plan, where it is signed in,
 * the email on request, reset time and share of the pool it restores, and the
 * reset-credit action. Opens on hover for a glance, on click to act.
 */
function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  /** Redeem state owned by the segment, since the confirm lives outside this popover. */
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const used = Math.round(window.usedPercent);
  const resetsIn = formatResetsIn(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const credits =
    account.driver !== "claudeAgent" && redeem && account.limits.resetCredits?.availableCount
      ? account.limits.resetCredits
      : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Used">{used}%</Row>
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="At reset">Frees {reset.restoresPercent}% of pool</Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border/60 pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={redeem.busy || !redeem.canManageProviders}
              className="ms-auto"
              onClick={onRedeem}
            >
              {redeem.busy ? "Using…" : "Use reset"}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One account's share of one pooled window: the segment, its popover, and the
 * reset confirm. The confirm is a sibling of the popover, not a child: dialogs
 * stack under popovers, and the popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  window,
  reset,
  now,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
}) {
  const [open, setOpen] = useState(false);
  const used = Math.round(window.usedPercent);
  const resetsIn = formatResetsIn(window, now);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            aria-label={`${account.displayName ?? (account.email ? accountInitials(account.email) : account.driver)}: ${used}% used${resetsIn ? `, ${resetsIn}` : ""}`}
            className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-md px-2 py-2 text-left text-xs hover:bg-(--sr-card) focus-visible:outline-2 focus-visible:outline-ring"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <AccountAvatar account={account} />
          <AccountName account={account} className="truncate" />
        </span>
        <span className="tabular-nums">{used}% used</span>
        <div className="col-span-full h-1.5 overflow-hidden rounded-full bg-(--sr-border)">
          <div
            aria-hidden
            className="h-full rounded-full bg-(--sr-gold)"
            style={{ width: `${Math.max(0, Math.min(100, used))}%` }}
          />
        </div>
        <span className="col-span-full text-(--sr-muted)">
          {resetsIn ?? "Reset time not reported."}
        </span>
      </PopoverTrigger>
      {account.redeem ? (
        <RedeemableSegmentPopup
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeemAt={account.redeem}
          closePopover={() => setOpen(false)}
        />
      ) : (
        <PopoverPopup side="top" sideOffset={6}>
          <SegmentPopover
            account={account}
            window={window}
            reset={reset}
            now={now}
            redeem={null}
            onRedeem={() => {}}
          />
        </PopoverPopup>
      )}
    </Popover>
  );
}

/** Split out so the redeem hook only runs for accounts that can redeem. */
function RedeemableSegmentPopup({
  account,
  window,
  reset,
  now,
  redeemAt,
  closePopover,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
  readonly closePopover: () => void;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <PopoverPopup side="top" sideOffset={6}>
        <SegmentPopover
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeem={redeem}
          onRedeem={() => {
            closePopover();
            redeem.setConfirming(true);
          }}
        />
      </PopoverPopup>
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so the outcome needs a home outside it. */}
      {redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={account} className="font-medium text-foreground" /> {redeem.status}
        </span>
      ) : null}
    </>
  );
}

/** A continuous used bar; account details retain their own resets and reset-credit actions. */
function PoolWindowCard({
  pool,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly now: number;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}) {
  const nextReset = pool.resets[0];
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  const resetLabel = nextReset ? formatResetsIn(nextReset.member.window, now) : null;
  const single = pool.columns.length === 1;
  const singleAccount = single ? pool.members[0] : undefined;
  return (
    <div className="border-t border-(--sr-border) px-6 py-5">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-3 sm:grid-cols-[minmax(9rem,0.75fr)_minmax(5rem,2fr)_auto]">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {label ?? pool.label}
            {single && ["Session", "Weekly"].includes(pool.label) ? " · all models" : ""}
          </span>
          <p className="mt-1 text-xs text-(--sr-muted)">
            {resetLabel
              ? `${single ? "R" : "Next r"}${resetLabel.slice(1)}`
              : "Reset time not reported."}
          </p>
        </div>
        <div
          role="meter"
          aria-label={`${label ?? pool.label} used`}
          aria-valuenow={pool.usedPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="col-span-full row-start-2 h-1.5 overflow-hidden rounded-full bg-(--sr-border) sm:col-span-1 sm:col-start-2 sm:row-start-1"
        >
          <div
            aria-hidden
            className="h-full rounded-full bg-(--sr-gold)"
            style={{ width: `${Math.max(0, Math.min(100, pool.usedPercent))}%` }}
          />
        </div>
        <span className="col-start-2 row-start-1 text-right text-sm tabular-nums sm:col-start-3">{`${pool.usedPercent}% used`}</span>
      </div>
      {description ? <p className="mt-2 text-xs text-(--sr-muted)">{description}</p> : null}
      <details className="mt-3 text-xs text-(--sr-muted)">
        <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">
          {singleAccount ? "Usage details" : `${pool.members.length} accounts · usage details`}
          {pool.pace ? (
            <span className="ml-2 inline-flex align-middle">
              <PaceIcon pace={pool.pace} />
            </span>
          ) : null}
        </summary>
        <div className="mt-2 grid gap-2">
          {pool.members.map((member) => (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              reset={pool.resets.find((reset) => reset.member.account.key === member.account.key)}
              now={now}
            />
          ))}
          {nextRefill && !single ? (
            <p>Next reset frees {nextRefill.restoresPercent}% of the pool.</p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function UsageSharedClaudeHeading({
  account,
  environmentId,
  provider,
}: {
  readonly account: LimitAccount;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}) {
  const canRead = useAtomValue(claudeAccountsEnvironment.snapshot.permissionAtom(environmentId));
  const read = useAtomCommand(claudeAccountsEnvironment.snapshot, { reportFailure: false });
  const [organization, setOrganization] = useState<string | null>(null);
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    void read({ environmentId, input: undefined })
      .then((result) => {
        if (!active || result._tag !== "Success") return;
        const current = result.value.accounts.find((candidate) => candidate.active);
        setOrganization(sharedClaudeOrganizationName(provider, current));
      })
      .catch(() => {
        if (active) setOrganization(null);
      });
    return () => {
      active = false;
    };
  }, [canRead, read, environmentId, provider]);
  return canRead && organization ? organization : <AccountName account={account} />;
}

/** Resolve shared organization names only for an exactly identified, verified native login. */
function UsageAccountHeading({
  account,
  presentations,
  now,
}: {
  readonly account: LimitAccount;
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  const environment = account.environments.length === 1 ? account.environments[0] : undefined;
  const provider = environment
    ? presentations
        .get(environment.environmentId)
        ?.serverConfig?.providers?.find(
          (candidate) => `${environment.environmentId}:${candidate.instanceId}` === account.key,
        )
    : undefined;
  return environment && provider && isSharedClaudeOrganizationContext(provider) ? (
    <UsageSharedClaudeHeading
      key={`${account.key}:${now}`}
      account={account}
      environmentId={environment.environmentId}
      provider={provider}
    />
  ) : (
    <AccountName account={account} />
  );
}

function PoolSection({
  pool,
  now,
  presentations,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
}) {
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  const account = pool.accounts.length === 1 ? pool.accounts[0] : undefined;
  return (
    <section className="overflow-hidden rounded-xl border border-(--sr-border) bg-(--sr-panel)">
      <div className="flex items-center gap-3 px-6 py-6">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          indicatorBackground="var(--sr-panel)"
          className="size-7"
          iconClassName="size-6"
        />
        <div className="min-w-0">
          <h2 className="text-lg font-medium">
            {account ? (
              <UsageAccountHeading account={account} presentations={presentations} now={now} />
            ) : (
              `${label} accounts`
            )}
          </h2>
          <p className="mt-1 text-xs text-(--sr-muted)">
            {account
              ? `${label} · ${account.environments.map((environment) => environment.label).join(", ") || account.sourceLabel || "Connected account"}`
              : `Combined limits · ${pool.accounts.length} accounts`}
          </p>
        </div>
      </div>
      {windows.map((window) => {
        const details = pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            now={now}
            label={details?.label}
            description={details?.description}
          />
        );
      })}
      <p className="px-6 pt-2 pb-5 text-xs text-(--sr-muted)">
        Usage snapshot · refresh to check for changes.
      </p>
    </section>
  );
}

/**
 * Accounts pooled per provider: what is open across all of them, who resets
 * next, and how much of the pool that hands back. Answers "can I keep going"
 * before "on which account".
 */
export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  const cursorPromptAt =
    Math.max(
      pools.findIndex((pool) => pool.driver === "codex"),
      pools.findIndex((pool) => pool.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {pools.map((pool, index) => (
        <Fragment key={pool.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <PoolSection pool={pool} now={now} presentations={presentations} />
        </Fragment>
      ))}
      {cursorPromptAt === pools.length ? cursorPrompt : null}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  View usage in ChatGPT with your connected account.
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

/** Sources and providers that could not be read, so a missing bar is not mistaken for a full one. */
function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
