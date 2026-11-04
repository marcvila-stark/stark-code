import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useProjects } from "../state/entities";
import { usePagesWebsiteEnvironment } from "./pagesWebsiteEnvironment";
import { PagesWebsiteView } from "./PagesWebsiteView";
import { PublishedStarkPages } from "./PublishedStarkPages";
import { StarkPagesSidebar } from "./StarkPagesSidebar";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

/** Global Pages has no chat side effects. Local files always belong to an explicitly shown folder. */
export function PagesHome({ folder }: { folder?: string | undefined }) {
  const navigate = useNavigate();
  const environmentId = usePagesWebsiteEnvironment();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [source, setSource] = useState<"company" | "local">("company");
  const [selectedFolder, setSelectedFolder] = useState(folder ?? null);
  const selected = projects.find((project) => project.workspaceRoot === selectedFolder);
  const website = Boolean(window.desktopBridge?.pagesWebsite);
  const [library, setLibrary] = useState(!website);
  return (
    <SidebarInset className="min-h-0 overflow-hidden">
      <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Pages">
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <Select
            value={source}
            onValueChange={(value) => {
              if (value === "company" || value === "local") setSource(value);
            }}
          >
            <SelectTrigger aria-label="Choose Pages source">
              <SelectValue>{source === "company" ? "Company pages" : "Local pages"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="company">Company pages</SelectItem>
              <SelectItem value="local">Local pages</SelectItem>
            </SelectPopup>
          </Select>
          {source === "local" ? (
            <div className="min-w-0 max-w-lg flex-1">
              <Select
                value={selected?.workspaceRoot ?? null}
                onValueChange={(value) => setSelectedFolder(value)}
              >
                <SelectTrigger aria-label="Local pages folder">
                  <SelectValue placeholder="Choose a folder">{selected?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.workspaceRoot}>
                      {project.title} · {project.workspaceRoot}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </header>
        <div
          hidden={source !== "company"}
          inert={source !== "company"}
          className={source === "company" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
        >
          {website ? (
            <div
              hidden={library}
              inert={library}
              className={library ? "hidden" : "flex min-h-0 flex-1 flex-col"}
            >
              <PagesWebsiteView
                active={source === "company" && !library}
                onOpenLibrary={() => setLibrary(true)}
                onEscape={() => void navigate({ to: "/" })}
              />
            </div>
          ) : null}
          {library ? (
            <>
              {website ? (
                <div className="px-4 py-2">
                  <Button variant="ghost" size="sm" onClick={() => setLibrary(false)}>
                    Show Pages website
                  </Button>
                </div>
              ) : null}
              <PublishedStarkPages active={source === "company"} />
            </>
          ) : null}
        </div>
        {source === "local" ? (
          selected ? (
            <StarkPagesSidebar
              key={selected.workspaceRoot}
              projectRoot={selected.workspaceRoot}
              agent="codex"
              canPublish={false}
              onPublishRequest={() => {}}
              onClose={() => setSelectedFolder(null)}
              showHeader={false}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <h1 className="text-xl font-medium">Pages built on this Mac</h1>
              <p className="max-w-md text-sm text-muted-foreground">
                {projects.length
                  ? "Choose the folder whose pages you want to browse."
                  : "Open a folder from Home to browse its local pages. Company pages are available without a chat or folder."}
              </p>
              {!projects.length ? (
                <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
                  Open Home
                </Button>
              ) : null}
            </div>
          )
        ) : null}
      </section>
    </SidebarInset>
  );
}
