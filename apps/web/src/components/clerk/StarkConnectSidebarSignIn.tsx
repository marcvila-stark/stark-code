import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { STARK_CONNECT_ACCOUNT_PAGES } from "./StarkConnectAccountPages";
import { useStarkConnectAuthPrompt } from "./useStarkConnectAuthPrompt";

export function StarkConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredStarkConnectSidebarSignIn />;
}

export function StarkConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredStarkConnectSidebarAvatar />;
}

function ConfiguredStarkConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {STARK_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

function ConfiguredStarkConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useStarkConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to Stark Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
