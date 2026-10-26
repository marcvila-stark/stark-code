import { useNavigation } from "@react-navigation/native";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";

export function SettingsLegalDocumentCloseHeaderButton() {
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityLabel="Close legal document"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => navigation.goBack()}
      className="p-2 active:opacity-60"
    >
      <SymbolView
        name="xmark"
        size={18}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

/** This build has local privacy information and no hosted legal documents. */
export function SettingsLegalDocumentExternalHeaderButton(_props: {
  readonly externalUrl?: string;
}) {
  return null;
}

export function SettingsLegalDocumentRouteScreen({
  documentName,
}: {
  readonly documentName: string;
  readonly documentUrl?: string;
}) {
  return (
    <ScrollView className="flex-1 bg-sheet" contentContainerClassName="p-6">
      <View className="gap-4">
        <Text className="font-stark-bold text-lg text-foreground">{documentName}</Text>
        <Text selectable className="text-base leading-normal text-foreground">
          Stark Code does not collect usage analytics or export diagnostics. Workspace history and
          logs stay in the configured environment&apos;s data directory.
        </Text>
        <Text selectable className="text-base leading-normal text-foreground">
          Claude, Codex, and installed plugins connect to their own services when you use them.
          License notices are included with the app&apos;s source and distribution.
        </Text>
      </View>
    </ScrollView>
  );
}
