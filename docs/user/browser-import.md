# Import browser sessions

The desktop app can copy sign-in cookies from another browser into its own **Personal imported
sessions** profile, so sites like Stark Pages open already signed in. The copies stay on this
computer, encrypted with your system keychain. They are not uploaded to Stark servers and are used
when you visit the selected websites. Agents cannot open this profile or any other personal
profile. They use a separate **Agent browser** whose sessions are discarded when the app quits.

During setup, choose **Browser** after connecting your agents. Your default browser is selected
when it is recognized. Choose **Review before importing**, pick the source profile and the sites
to copy, then choose **Copy sign-ins**. **Stark sites** and **Sign-in providers** (Google,
Microsoft and GitHub) are one-click sets when your browser has them. Choose the site names under a
set to list every site in it and untick the ones you don't want. Every other site is under
**Other sites**, where you can also add one by name. Nothing starts selected, and
one import copies up to 100 sites. Only the exact selected sites are copied; a parent domain is a
separate choice because its cookies can sign you into multiple subdomains. If a site still asks
you to sign in, copy its sign-in provider too.

To import later, open **Settings → Integrations → Browser profiles →
Add profile**, then choose a browser under **Import from**. Close the source browser before
importing, and allow an operating-system keyring unlock prompt if one appears.
Imports always go into Personal imported sessions, regardless of the current default profile.
To remove imported sign-ins, choose **Clear cookies and cache** for Personal imported sessions
in the same list.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.
Saved passwords, bookmarks and browsing history are not imported.

On macOS, Zen profiles are supported alongside Firefox. Only the default container's cookies
are copied; separate container logins remain in the source browser.

Existing imported sessions stay in their personal profiles after an update and
remain unavailable to agents. Before an agent reads or acts on a site in Agent
browser, approve that site's origin in the browser panel or native app prompt.
That permission does not copy any sessions from Personal imported sessions. Closing the
agent tab or clearing its cookies ends the permission.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag Stark Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen Stark Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

Session imports require a packaged build with cookie encryption and an available OS keyring.
Development builds can show available browsers and sites, but cannot import sessions.
Ordinary browsing remains available.
