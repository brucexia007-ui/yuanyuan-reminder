import { invoke } from "@tauri-apps/api/core";

/** Use the registered native message command, not the legacy DOM shim. */
export async function confirmAction(message: string): Promise<boolean> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    // The dialog plugin's confirm permission is an alias for message; its
    // injected window.confirm may still call the removed confirm command.
    const result = await invoke<unknown>("plugin:dialog|message", {
      title: "确认操作",
      message,
      kind: "warning",
      buttons: "OkCancel",
    });
    return result === "Ok";
  }
  // Do not treat a Promise (or any other truthy value) as consent. Rejections
  // reach the caller's error UI, and no destructive command may run first.
  return (await window.confirm(message)) === true;
}
