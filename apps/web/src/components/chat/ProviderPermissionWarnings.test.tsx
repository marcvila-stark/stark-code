import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderPermissionWarnings } from "./ProviderPermissionWarnings";
import { PROVIDER_PERMISSION_WARNING } from "../../composerPermissionWarnings";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("shows the selected reference's warning until the draft no longer uses it", async () => {
  await act(async () => {
    renderer = create(
      <ProviderPermissionWarnings
        warnings={[{ reference: "/deploy:ship", warning: PROVIDER_PERMISSION_WARNING }]}
      />,
    );
  });
  expect(renderer!.root.findByType("code").children.join("")).toBe("/deploy:ship");
  expect(renderer!.root.findByType("p").children.join("")).toContain(
    "Some tool calls may run without a Stark approval prompt.",
  );
  await act(async () => renderer!.update(<ProviderPermissionWarnings warnings={[]} />));
  expect(renderer!.toJSON()).toBeNull();
});
