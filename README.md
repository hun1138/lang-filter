# YouTube Language Filter

A Chrome extension that filters YouTube comments by language. Show only comments in your preferred languages and hide or collapse the rest—all without sending any data externally.

## Features

- **Language Filtering**: Show only comments in your allowed languages
- **Local Detection**: Uses Chrome's built-in `chrome.i18n.detectLanguage` API—no external services
- **Two Display Modes**:
  - **Hide**: Completely hide non-allowed comments
  - **Collapse**: Show a placeholder with option to expand individual comments
- **Dynamic Loading Support**: Automatically processes new comments as you scroll
- **Privacy Focused**: No data collection, no network requests for detection

## Installation

### Load as Unpacked Extension (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `extension` folder from this project
5. The extension icon should appear in your toolbar

## Usage

1. **Open the Extension Popup**: Click the extension icon in your Chrome toolbar
2. **Enable Filtering**: Toggle "Enable filtering" on
3. **Select Languages**: Check the languages you want to see comments in
4. **Choose Display Mode**:
   - **Hide**: Non-allowed comments are completely hidden
   - **Collapse**: Non-allowed comments show a placeholder with a "Show" button
5. **Unknown Language Handling**: Optionally hide comments where the language cannot be detected
6. **Navigate to YouTube**: Go to any YouTube video page (youtube.com/watch?v=...)
7. **Scroll Through Comments**: Comments will be filtered automatically as they load

### Re-scanning

If comments aren't being filtered correctly, click the **Re-scan Current Page** button in the popup to reprocess all comments.

## Supported Languages

The extension provides quick-select options for these languages:

- English (en)
- Korean (ko)
- Japanese (ja)
- Chinese (zh)
- Spanish (es)
- French (fr)
- German (de)
- Portuguese (pt)
- Russian (ru)
- Hindi (hi)
- Arabic (ar)
- Italian (it)
- Thai (th)
- Vietnamese (vi)
- Indonesian (id)
- Turkish (tr)

## How It Works

1. The extension injects a content script on YouTube pages
2. A MutationObserver watches for new comments being added to the DOM
3. For each comment, the text is extracted and analyzed using `chrome.i18n.detectLanguage`
4. Based on your settings, comments are either shown, hidden, or collapsed
5. Settings are persisted in `chrome.storage.local`

## Known Limitations

- **Language Detection Accuracy**: Chrome's built-in detection may not always be accurate, especially for:
  - Very short comments
  - Comments with mostly emojis or links
  - Mixed-language comments (only the dominant language is detected)
- **YouTube DOM Changes**: YouTube may update their page structure, which could temporarily break the extension
- **Not Supported**:
  - YouTube Shorts comments
  - Live chat messages
  - Community posts

## Privacy

This extension:
- Does **NOT** collect any user data
- Does **NOT** make any network requests for language detection
- Only uses Chrome's local APIs
- Only has permission to access YouTube pages

## Troubleshooting

### Comments not being filtered

1. Make sure the extension is enabled (toggle is on)
2. Make sure you've selected at least one allowed language
3. Try clicking "Re-scan Current Page"
4. Try refreshing the YouTube page

### Extension popup shows error

1. Make sure you're on a YouTube watch page (youtube.com/watch?v=...)
2. Try refreshing the page
3. Try reloading the extension from chrome://extensions/

## Development

### File Structure

```
extension/
├── manifest.json          # Extension manifest (MV3)
├── content/
│   ├── content.js         # Main filtering logic
│   └── content.css        # Styles for hide/collapse modes
├── popup/
│   ├── popup.html         # Settings UI
│   ├── popup.js           # Settings logic
│   └── popup.css          # Popup styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

### Storage Schema

```javascript
{
  settings: {
    enabled: boolean,        // Whether filtering is active
    allowedLangs: string[],  // ISO language codes (e.g., ["en", "ko"])
    mode: "hide" | "collapse",
    hideUnknown: boolean     // Whether to hide unknown language comments
  }
}
```

## License

MIT License
