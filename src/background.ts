browser.runtime.onMessage.addListener((msg: unknown) => {
  if ((msg as { type?: string } | null)?.type === "open-options") {
    void browser.runtime.openOptionsPage();
  }
});

browser.action.onClicked.addListener(() => void browser.runtime.openOptionsPage());
