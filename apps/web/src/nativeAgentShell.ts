export const NATIVE_AGENT_SHELL_TOGGLE_EVENT = "starkcode:toggle-native-agent-shell";
export const NATIVE_AGENT_VOICE_OPEN_EVENT = "starkcode:open-native-agent-voice";

export function toggleNativeAgentShell(): void {
  window.dispatchEvent(new Event(NATIVE_AGENT_SHELL_TOGGLE_EVENT));
}

export function openNativeAgentVoice(): void {
  window.dispatchEvent(new Event(NATIVE_AGENT_VOICE_OPEN_EVENT));
}
