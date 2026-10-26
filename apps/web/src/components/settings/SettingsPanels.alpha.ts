import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type ServerSettings,
  type UnifiedSettings,
} from "@starkfuture/contracts/settings";
type CompatibilitySettingKey =
  | "planModeEnabled"
  | "contextWindowMeterEnabled"
  | "legacySidebarEnabled"
  | "sidebarWorkingShelfEnabled"
  | "sidebarAutoSettleOnMerge"
  | "sidebarAutoSettleAfterDays"
  | "sidebarProjectGroupingMode"
  | "timestampFormat"
  | "environmentIdentificationMode"
  | "glassOpacity"
  | "proactivePanelsEnabled"
  | "showSkillsInSlashMenu"
  | "addProjectBaseDirectory"
  | "autoResumeLimitedThreads"
  | "snoozeLimitedThreads";
type CompatibilityPatch = Partial<Pick<UnifiedSettings, CompatibilitySettingKey>>;

type CompatibilityPreference = {
  id: string;
  title: string;
  description: string;
  action: string;
  patch: CompatibilityPatch;
};

/** Only saved exceptions get recovery controls; alpha users cannot enable retired UI here. */
export function alphaCompatibilityPreferences(
  settings: UnifiedSettings,
): CompatibilityPreference[] {
  const preferences: CompatibilityPreference[] = [];
  const keep = (
    active: boolean,
    id: string,
    title: string,
    description: string,
    action: string,
    patch: CompatibilityPatch,
  ) => {
    if (active) preferences.push({ id, title, description, action, patch });
  };
  keep(
    settings.planModeEnabled,
    "legacy-plan-mode",
    "Legacy Build / Plan controls",
    "The older Build / Plan controls are still enabled.",
    "Use current controls",
    { planModeEnabled: false },
  );
  keep(
    settings.contextWindowMeterEnabled,
    "legacy-context-window-indicator",
    "Legacy context indicator",
    "The older context-window indicator is still enabled.",
    "Turn off",
    { contextWindowMeterEnabled: false },
  );
  keep(
    settings.legacySidebarEnabled,
    "legacy-sidebar",
    "Legacy sidebar",
    "Chats are still grouped in the older per-folder tree.",
    "Use current sidebar",
    { legacySidebarEnabled: false },
  );
  keep(
    settings.sidebarWorkingShelfEnabled,
    "working-shelf",
    "Working section",
    "Working chats are collected in a separate sidebar section.",
    "Turn off",
    { sidebarWorkingShelfEnabled: false },
  );
  keep(
    settings.sidebarAutoSettleOnMerge,
    "auto-settle-merged-threads",
    "Auto-settle merged chats",
    "Chats are automatically marked settled when their pull request merges.",
    "Turn off",
    { sidebarAutoSettleOnMerge: false },
  );
  keep(
    settings.sidebarAutoSettleAfterDays !== null,
    "auto-settle-inactive-threads",
    "Auto-settle inactive chats",
    `Chats settle after ${settings.sidebarAutoSettleAfterDays ?? 0} days without activity.`,
    "Turn off",
    { sidebarAutoSettleAfterDays: null },
  );
  keep(
    settings.sidebarProjectGroupingMode !== "separate",
    "project-grouping",
    "Cross-computer folder grouping",
    "Matching repositories on different computers are grouped together.",
    "Keep folders separate",
    { sidebarProjectGroupingMode: "separate" },
  );
  keep(
    settings.timestampFormat !== "locale",
    "time-format",
    "Custom time format",
    `Times use ${settings.timestampFormat} formatting.`,
    "Use system format",
    { timestampFormat: "locale" },
  );
  keep(
    settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
    "environment-identification",
    "Custom build identification",
    `Build identification is set to ${settings.environmentIdentificationMode}.`,
    "Use build default",
    { environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode },
  );
  keep(
    settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity,
    "setting-glass-opacity",
    "Custom surface opacity",
    `Menus and the composer use ${settings.glassOpacity}% opacity.`,
    "Use default surfaces",
    { glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity },
  );
  keep(
    settings.proactivePanelsEnabled,
    "proactive-panels",
    "Automatic panel opening",
    "Changes and pull requests may open a panel automatically.",
    "Open tools on request",
    { proactivePanelsEnabled: false },
  );
  keep(
    !settings.showSkillsInSlashMenu,
    "skills-in-slash-menu",
    "Skills hidden from slash commands",
    "Available skills are currently hidden from the / menu.",
    "Show available skills",
    { showSkillsInSlashMenu: true },
  );
  keep(
    settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
    "add-project-starts-in",
    "Custom folder starting location",
    `The folder chooser starts in ${settings.addProjectBaseDirectory}.`,
    "Use default location",
    { addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory },
  );

  keep(
    settings.autoResumeLimitedThreads,
    "auto-resume-limited-threads",
    "Automatic quota continuation",
    "Stopped chats resume after a usage limit resets. This can spend tokens without another message.",
    "Turn off",
    { autoResumeLimitedThreads: false },
  );
  keep(
    settings.snoozeLimitedThreads,
    "snooze-limited-threads",
    "Automatic quota snoozing",
    "Chats stopped by usage limits are snoozed until their reset time.",
    "Turn off",
    { snoozeLimitedThreads: false },
  );
  return preferences;
}

/** A non-representative target can still have an active saved policy. Keep its off switch. */
export function alphaCompatibilityPreferencesForTargets(targets: readonly UnifiedSettings[]) {
  const entries = new Map<string, CompatibilityPreference>();
  for (const target of targets) {
    for (const entry of alphaCompatibilityPreferences(target)) {
      if (!entries.has(entry.id)) entries.set(entry.id, entry);
    }
  }
  return [...entries.values()].map((entry) => {
    const keys = Object.keys(entry.patch) as CompatibilitySettingKey[];
    const first = targets[0];
    const mixed =
      first !== undefined &&
      targets.some((target) => keys.some((key) => target[key] !== first[key]));
    const settingKeys = Object.keys(entry.patch).filter(
      (key): key is keyof ServerSettings => key in DEFAULT_SERVER_SETTINGS,
    );
    return { ...entry, mixed, settingKeys };
  });
}
