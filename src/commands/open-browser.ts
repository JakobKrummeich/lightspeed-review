import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  launchBrowser(command, url);
}

/** Best effort: a headless box with no `xdg-open` must not fail a review the agent
 * can still poll, and the URL is in the output anyway. The spawn failure arrives as
 * an event — without a listener it takes the process down. */
export function launchBrowser(command: string, url: string): void {
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
