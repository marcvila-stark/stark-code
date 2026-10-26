import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@starkfuture/contracts";
import { providerClients } from "./providerDriverMeta";

vi.mock("../ui/draft-input", () => ({
  DraftInput: (props: { id: string; value: string; onCommit: (value: string) => void }) => (
    <input
      id={props.id}
      value={props.value}
      onChange={(event) => props.onCommit(event.target.value)}
    />
  ),
}));
import { ProviderSettingsForm } from "./ProviderSettingsForm";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("refuses unsafe account launch arguments before save and clears the error after correction", async () => {
  const onChange = vi.fn();
  const definition = providerClients.get(ProviderDriverKind.make("codex"))!;
  await act(async () => {
    renderer = create(
      <ProviderSettingsForm
        definition={definition}
        value={{}}
        idPrefix="account"
        variant="card"
        onChange={onChange}
      />,
    );
  });
  const input = renderer!.root
    .findAllByType("input")
    .find((node) => node.props.id === "account-launchArgs")!;
  await act(async () => input.props.onChange({ target: { value: "-s danger-full-access" } }));
  expect(onChange).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "-s danger-full-access",
  );
  await act(async () => input.props.onChange({ target: { value: "-p company -a untrusted" } }));
  expect(onChange).toHaveBeenCalledWith({ launchArgs: "-p company -a untrusted" });
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});
