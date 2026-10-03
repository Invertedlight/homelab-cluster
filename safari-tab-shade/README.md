# Tab Shade

Safari extension that gives each tab its own color. Safari will not paint inactive tabs one by one, and it does not tell an extension about tab groups. Tab Shade marks each tab in three ways you can turn on and off separately, and it remembers colors by site and by URL.

## Markers

Each marker follows the color chosen for that tab. Turn them on and off in the popup. They do not depend on each other.

- **Emoji in the title.** The tab title starts with a colored square (🟥🟧🟨🟩🟦🟪🟫⬛⬜), whichever is closest to the color. A zero-width space sits after it, so applying it again does not stack a second emoji, and a page whose real title already starts with one of those squares is left alone. Pages that rewrite `document.title`, including single-page apps, get the marker put back. Turning the color or the emoji off removes it.
- **Colored icon.** The tab’s favicon link is replaced with a rounded square in the same color, drawn on a canvas as a PNG (an SVG data URL if the canvas is unavailable). Turning it off puts the page’s original icons back. Safari has long ignored favicon changes after it has cached a site’s icon, so this marker is best-effort: it is applied as early as the color is known, and again whenever the page rewrites its icons. The emoji is the marker that stays visible when a title is truncated, because it is the first character and Safari cuts titles off at the end.
- **Top strip.** Unchanged from the first version. Safari 15 through 18 read a `theme-color` meta tag, and Tab Shade sets that tag. Safari 26 reads a real color from the top of the page when **Settings → Tabs → Show color in tab bar** is on. Tab Shade places a 12px solid strip there. WebKit ignores a shorter fixed box, and it samples a point about 4px down. Clicks pass through the strip. The strip only changes the bar of the tab you are looking at. The emoji and the icon are what distinguish the other tabs.

The page itself is otherwise left alone. With every marker off, Safari keeps its own tab color.

## Colors

An automatic color is a stable mix of the palette, so `github.com` and `mail.google.com` differ. A leading `www.` does not.

You can pick a swatch or type a hex value.

- **This site** is stored in `storage.local` under the hostname. It survives quitting Safari and applies in every tab that opens the site. **Site default** leaves that site on the page’s own color. **Automatic** clears the saved choice.
- **Include subdomains** stores the choice on that hostname and also uses it for hosts underneath it. `google.com` with this on covers `mail.google.com`. A color saved on the full hostname wins, including a site-default that turns the color off. The checkbox applies to a chosen color or to site default, not to the automatic color.
- **Only this tab** overrides the site. While Safari stays open, that color follows the tab as you move between pages on the same host. A blank or non-web address in the middle of a navigation does not clear it. Going to a different host, including a different subdomain, drops it for the tab you are in.
- The color is also saved for exact `http` and `https` URLs (host lowercased, hash removed): the page where you set it, and the page that tab is on now if you moved within the site. Pages you only passed through are not kept. Reopening either saved URL, including after Safari quits, restores the color. Tab ids do not survive a restart, so the URL is the key. Two tabs open to the same URL share that override. Closing a tab does not forget the saved URLs; clear the tab, or turn the color off, to remove them. The map keeps 200 URLs and drops the ones least recently used.
- **Several tabs** writes that per-tab color onto the tabs you choose. **This window** does every site tab in the window. **Color selected** does the ones you check. **Clear window** and **Clear selected** remove those overrides so the site color shows again. Safari’s `tabs.query({ currentWindow: true })` is what the popup uses. `tabGroups` and `theme` are not available.

## Safari settings

On Safari 17 and later: **Settings → Developer → Allow unsigned extensions**. On older Safari the same switch is **Develop → Allow Unsigned Extensions**.

**Settings → Extensions → Tab Shade.** Turn it on and allow it on all websites. Without that, markers only run on sites you approved one by one, and the popup cannot list the other tabs.

**Settings → Tabs → Show color in tab bar.** Safari 26 needs this for the top strip. The emoji and the colored icon do not.

## Install

On a Mac with Xcode and Node:

```sh
cd safari-tab-shade
./scripts/convert.sh
```

The script calls `xcrun safari-web-extension-packager` (older Xcode still has `safari-web-extension-converter`). It writes an Xcode project under `build/safari/`, inside a folder named `Tab Shade`, because the tool names the folder from `manifest.json`. The path `Tab Shade/Tab Shade.xcodeproj` is not created.

The script passes `--bundle-identifier com.invertedlight.tabshade`. With `--macos-only`, the packager still names the host app `com.invertedlight.Tab-Shade` (the manifest title, with the space turned into a hyphen) and leaves the extension at `com.invertedlight.tabshade.Extension`. `--app-name` only titles the project; it does not keep those ids in prefix. Xcode then refuses to build, because the embedded extension id has to start with the app id. The script rewrites the app id to `com.invertedlight.tabshade` from each target’s product type, and stops if any id still misses that prefix.

Build the Tab Shade scheme. The product is `Tab Shade.app` in Xcode’s DerivedData folder (**Product → Show Build Folder in Finder**). Copy that one app to `/Applications`.

Keep a single copy registered. Xcode’s Run also registers the DerivedData build. Two apps with the bundle id `com.invertedlight.tabshade` make Safari show a duplicate or a dead extension. Quit the copy Xcode launched, keep the one in `/Applications`, and delete the extra `Tab Shade.app`. If the extension still appears twice, turn it off and on under Settings → Extensions.

To rebuild, run `./scripts/convert.sh` again (it deletes `build/safari` first), build in Xcode, quit the old app, and replace `/Applications/Tab Shade.app`.

The generated Xcode project is gitignored.

## Develop

Color choice, title prefixes, the URL map, and the bundle-id rewrite are covered by:

```sh
node --test safari-tab-shade/test/color.test.mjs safari-tab-shade/test/bundle-id.test.mjs
```

Regenerate the toolbar icons with `python3 safari-tab-shade/scripts/generate-icons.py`.

Open `extension/popup.html` in a browser to click through the popup. Outside Safari it uses sample tabs, so the buttons only update that preview.
