browser.runtime.onMessage.addListener((message: unknown) => {
  const m = message as null | { repo?: string; type?: string };
  if (m?.type !== 'open-options') return;
  if (m.repo) {
    // Opens the options page scrolled to this repo's overrides.
    void browser.tabs.create({
      url: browser.runtime.getURL(
        `options.html?repo=${encodeURIComponent(m.repo)}`
      ),
    });
  } else {
    void browser.runtime.openOptionsPage();
  }
});

browser.action.onClicked.addListener(
  () => void browser.runtime.openOptionsPage()
);
