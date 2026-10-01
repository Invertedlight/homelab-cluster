# Tab Shade

Safari extension that gives each website a solid tab color. Safari keeps drawing the site icon and the page title on top of that fill.

Safari does not let an extension paint inactive tabs one by one. It paints the tab bar from the page you are looking at, then changes that color when you switch tabs. Tab Shade is the part that picks the color.

## What you get

- Each site gets a stable solid color. `github.com` and `mail.google.com` can differ. A leading `www.` does not.
- You can pick a color, type a hex value, or leave the site on its automatic color.
- “Only this tab” keeps a color on that tab until you close it.
- “Site default” leaves that site on the page’s own color.
- The toolbar icon and the popup preview show the fill with the icon and title on top.

## How Safari applies it

Safari 15 through 18 read a `theme-color` meta tag. Tab Shade sets that tag. The page itself is left alone.

Safari 26 reads a real color from the top of the page when **Settings → Tabs → Show color in tab bar** is on. Tab Shade places a 12px solid strip there. WebKit ignores a shorter fixed box, and it samples a point about 4px down, so the strip has to be that size. Clicks pass through it. Turn the strip off in the popup if you would rather keep the page untouched; on Safari 26 the tab bar then keeps the page’s own color.

## Install

On a Mac with Xcode:

```sh
cd safari-tab-shade
./scripts/convert.sh
open "Tab Shade/Tab Shade.xcodeproj"
```

Run the Tab Shade scheme. In Safari, enable unsigned extensions (Develop menu, or Settings → Developer on Safari 17 and later), then enable Tab Shade under Settings → Extensions. Allow it on all websites. For Safari 26, turn on Settings → Tabs → Show color in tab bar.

`scripts/convert.sh` uses `xcrun safari-web-extension-converter` and writes an Xcode project that is gitignored.

## Develop

Color choice is covered by:

```sh
node --test safari-tab-shade/test/color.test.mjs
```

Regenerate the toolbar icons with `python3 safari-tab-shade/scripts/generate-icons.py`.

Open `extension/popup.html` in a browser to click through the popup. Outside Safari it uses sample tab data, so the buttons only update that preview.
