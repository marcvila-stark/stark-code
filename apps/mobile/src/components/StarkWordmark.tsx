import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The Stark brand mark, matching the desktop sidebar's wordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function StarkWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 1;
  return (
    <Svg
      accessibilityLabel="Stark"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 128 128"
    >
      <ThemedPath
        d="M64 13 A51 51 0 1 1 64 115 A51 51 0 1 1 64 13 Z M64 21 A43 43 0 1 0 64 107 A43 43 0 1 0 64 21 Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
