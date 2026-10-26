import { resolveOnboardingLocalEnvironment } from "../onboarding/targetEnvironment.logic";
import { useEnvironments } from "../state/environments";

/** Website cookies stay on the desktop host, regardless of the active chat's machine. */
export function usePagesWebsiteEnvironment() {
  const { environments } = useEnvironments();
  return (
    resolveOnboardingLocalEnvironment(
      environments,
      window.desktopBridge?.getLocalEnvironmentBootstraps?.() ?? [],
    )?.environmentId ?? null
  );
}
