# Tab Shade

Safari extension that gives each tab its own color. Safari will not paint inactive tabs one by one, and it does not tell an extension about tab groups. Tab Shade marks each tab in three ways you can turn on and off separately, and it remembers colors by site and by URL.

## Markers

Each marker follows the color chosen for that tab. Turn them on and off in the popup. They do not depend on each other.

- **Emoji in the title.** The tab title starts with a colored square (🟥🟧🟨🟩🟦🟪🟫⬛⬜), whichever is closest to the color. A zero-width space sits after it, so applying it again does not stack a second emoji, and a page whose real title already starts with one of those squares is left alone. Pages that rewrite `document.title`, including single-page apps, get the marker put back. Turning the color or the emoji off removes it.
- **Colored icon.** The tab’s favicon link is replaced with a rounded square in the same color, drawn on a canvas as a PNG (an SVG data URL if the canvas is unavailable). Turning it off puts the page’s original icons back. Safari has long ignored favicon changes after it has cached a site’s icon, so this marker is best-effort: it is applied as early as the color is known, and again whenever the page rewrites its icons. The emoji is the marker that stays visible when a title is truncated, because it is the first character and Safari cuts titles off at the end.
- **Top strip.** On a Mac, Safari 15 through 18 read a `theme-color` meta tag, and Tab Shade sets that tag. macOS Safari 26 reads a real color from the top of the page when **Settings → Tabs → Show color in tab bar** is on. Tab Shade places a 12px solid strip there. WebKit ignores a shorter fixed box, and it samples a point about 4px down. Clicks pass through the strip. The strip only changes the bar of the tab you are looking at. iPhone and iPad do not get that strip. They keep the emoji, the colored icon, and a `theme-color` tag, which Safari on those devices uses for the toolbar. The emoji and the icon are what distinguish the other tabs.

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

The app is signed with your Apple Developer team. Enable the extension as below. If Safari still refuses it, on Safari 17 and later turn on **Settings → Developer → Allow unsigned extensions**. On older Safari the same switch is **Develop → Allow Unsigned Extensions**. A development signature is enough on your own Mac, iPhone, and iPad. Notarization is a later step for copies you send to other people.

**Settings → Extensions → Tab Shade.** Turn it on and allow it on all websites. Without that, markers only run on sites you approved one by one, and the popup cannot list the other tabs.

**Settings → Tabs → Show color in tab bar** on the Mac. macOS Safari 26 needs this for the top strip. The emoji and the colored icon do not. iPhone and iPad do not use that setting.

## Install

On a Mac with Xcode, the iOS platform installed, and Node. Sign in to Xcode with the Apple Developer account (**Xcode → Settings → Accounts**). The 10-character Team ID is on that team, and on [developer.apple.com/account](https://developer.apple.com/account) under Membership.

```sh
printf '%s\n' 'YOURTEAMID' > safari-tab-shade/apple-team-id
cd safari-tab-shade
./scripts/convert.sh
```

`apple-team-id` is gitignored. `APPLE_TEAM_ID` works the same if you would rather not write the file. The script refuses to run without a team id. It does not ad-hoc sign.

The script calls `xcrun safari-web-extension-packager` (older Xcode still has `safari-web-extension-converter`). It writes one Xcode project under `build/safari/`, inside a folder named `Tab Shade`, with a Mac target and an iPhone/iPad target. The path `Tab Shade/Tab Shade.xcodeproj` is not created.

The script passes `--bundle-identifier com.invertedlight.tabshade`. The packager can still name a host app `com.invertedlight.Tab-Shade` (the manifest title, with the space turned into a hyphen) and leave an extension at `com.invertedlight.tabshade.Extension`. `--app-name` only titles the project. The script rewrites every app id to `com.invertedlight.tabshade`, sets `DEVELOPMENT_TEAM` and automatic signing on every configuration, sets the iOS target’s device family to iPhone and iPad, and stops if any id misses the prefix.

List the schemes, then build the Mac one. The scheme is often `Tab Shade (macOS)`. If the list shows only `Tab Shade`, use that name.

```sh
project=$(find build/safari -name '*.xcodeproj' -print | head -n 1)
xcodebuild -list -project "$project"
xcodebuild \
  -project "$project" \
  -scheme "Tab Shade (macOS)" \
  -configuration Release \
  -destination "platform=macOS" \
  -derivedDataPath build/DerivedData \
  build
```

Copy that one app to `/Applications`. Quit any Tab Shade Xcode already launched. Two apps with the bundle id `com.invertedlight.tabshade` make Safari show a duplicate or a dead extension.

```sh
osascript -e 'quit app "Tab Shade"' || true
rm -rf "/Applications/Tab Shade.app"
cp -R "build/DerivedData/Build/Products/Release/Tab Shade.app" "/Applications/Tab Shade.app"
open "/Applications/Tab Shade.app"
```

For an iPhone or iPad, plug it in, unlock it, and trust the Mac. Automatic signing uses the same team. The first run registers the device. In Xcode, select the iOS scheme (`Tab Shade (iOS)` when that is the name) and the device, then Run. Or:

```sh
xcodebuild \
  -project "$project" \
  -scheme "Tab Shade (iOS)" \
  -configuration Debug \
  -destination "platform=iOS,name=YOUR DEVICE" \
  -allowProvisioningUpdates \
  build
```

Installing the iOS app is what registers the extension. On the device: **Settings → Safari → Extensions → Tab Shade**, allow all websites. The Mac strip setting does not apply there.

To rebuild, run `./scripts/convert.sh` again (it deletes `build/safari` first), build, quit the old app, and replace `/Applications/Tab Shade.app`. Rebuild the iOS scheme to update the phone or tablet.

The generated Xcode project is gitignored.

## Develop

Color choice, title prefixes, the URL map, and the bundle-id rewrite are covered by:

```sh
node --test safari-tab-shade/test/color.test.mjs safari-tab-shade/test/bundle-id.test.mjs
```

Regenerate the toolbar icons with `python3 safari-tab-shade/scripts/generate-icons.py`.

Open `extension/popup.html` in a browser to click through the popup. Outside Safari it uses sample tabs, so the buttons only update that preview.
