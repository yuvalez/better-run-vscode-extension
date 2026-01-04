import * as vscode from "vscode";
import { BetterRunTreeProvider } from "./tree";
import type { LaunchItem, TaskItem } from "./sources";
import { Storage } from "./storage";


type LaunchArg =
  | LaunchItem
  | { kind: "launch"; item: LaunchItem }
  | { item: LaunchItem };

type TaskArg =
  | TaskItem
  | { kind: "task"; item: TaskItem }
  | { kind: "taskTop"; item: TaskItem }
  | { item: TaskItem };

function unwrapLaunch(arg: unknown): LaunchItem | undefined {
  if (!arg || typeof arg !== "object") return undefined;

  const a = arg as any;
  if (typeof a.name === "string" && a.config) return a as LaunchItem;
  if (a.item && typeof a.item.name === "string" && a.item.config) return a.item as LaunchItem;

  return undefined;
}

function unwrapTask(arg: unknown): TaskItem | undefined {
  if (!arg || typeof arg !== "object") return undefined;

  const a = arg as any;
  if (typeof a.label === "string") return a as TaskItem;
  if (a.item && typeof a.item.label === "string") return a.item as TaskItem;

  return undefined;
}

const VIEW_ID = "betterRun.runs";

export function activate(context: vscode.ExtensionContext) {
  const storage = new Storage(context);

  const provider = new BetterRunTreeProvider(storage);

  // IMPORTANT: createTreeView gives you TreeView API + built-in collapse-all button support
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true, // adds the collapse-all button in the view title
  });

  context.subscriptions.push(treeView);

  context.subscriptions.push(vscode.commands.registerCommand("betterRun.refresh", async () => provider.refresh()));

  // Keybindable "collapse all" (works even if the view isn't focused)
  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.collapseAll", async () => {
      // VS Code auto-creates a command for each tree view:
      // workbench.actions.treeView.<VIEW_ID>.collapseAll
      await vscode.commands.executeCommand(`workbench.actions.treeView.${VIEW_ID}.collapseAll`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.searchByName", async () => {
      const current = storage.getNameFilter();
      const value = await vscode.window.showInputBox({
        title: "Better Run: Search by Name",
        prompt: "Filter launches and tasks by name (case-insensitive). Leave empty to clear.",
        value: current,
      });

      if (value === undefined) return; // cancelled
      await storage.setNameFilter(value.trim());
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.clearSearch", async () => {
      await storage.setNameFilter("");
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.debugLaunch", async (arg: LaunchArg) => {
      const item = unwrapLaunch(arg);
      if (!item?.config) return;
  
      // Use the config object directly (works even if it’s NOT in launch.json)
      const cfg = { ...item.config };
  
      // Make sure it has a name (VS Code uses this in UI)
      cfg.name = cfg.name || item.name;
  
      const folder = item.workspaceFolder; // undefined allowed (user/global)
      const ok = await vscode.debug.startDebugging(folder, cfg);
  
      if (!ok) {
        vscode.window.showErrorMessage(`Failed to debug '${item.name}'.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.runLaunch", async (arg: LaunchArg) => {
      const item = unwrapLaunch(arg);
      if (!item?.config) return;
  
      const cfg = { ...item.config, name: item.name, noDebug: true };
      const folder = item.workspaceFolder; // undefined allowed (user/global)
      const ok = await vscode.debug.startDebugging(folder, cfg);
      if (!ok) vscode.window.showErrorMessage(`Failed to run '${item.name}'.`);
    })
  );

  context.subscriptions.push(
      vscode.commands.registerCommand("betterRun.runTask", async (arg: TaskArg) => {
      const item = unwrapTask(arg);
      if (!item) return;

      // User settings tasks: run via terminal
      if (item.userTask) {
        const terminal = vscode.window.createTerminal({
          name: item.userTask.label,
          cwd: item.userTask.cwd,
        });
        terminal.show(true);
        terminal.sendText(item.userTask.command, true);
        return;
      }

      // Workspace tasks.json tasks: execute via VS Code task system (match by label)
      const label = item.label;
      const workspaceFolder = item.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];

      const allTasks = await vscode.tasks.fetchTasks();
      const candidates = allTasks.filter((t) => {
        const sameLabel =
          t.name === label ||
          // some tasks set label under definition
          (typeof (t.definition as any)?.label === "string" && (t.definition as any).label === label);

        if (!sameLabel) return false;

        if (!workspaceFolder) return true;

        const tFolder =
          t.scope && typeof t.scope === "object" && "uri" in (t.scope as any)
            ? (t.scope as vscode.WorkspaceFolder)
            : undefined;

        // if task is global/workspace-scoped, allow it
        if (!tFolder) return true;

        return tFolder.uri.toString() === workspaceFolder.uri.toString();
      });

      if (!candidates.length) {
        vscode.window.showWarningMessage(`Task not found: ${label}`);
        return;
      }

      // Prefer task scoped to the same folder
      const best =
        (workspaceFolder &&
          candidates.find((t) => {
            const tFolder =
              t.scope && typeof t.scope === "object" && "uri" in (t.scope as any)
                ? (t.scope as vscode.WorkspaceFolder)
                : undefined;
            return tFolder?.uri.toString() === workspaceFolder.uri.toString();
          })) ||
        candidates[0];

      await vscode.tasks.executeTask(best);
    })
  );

  // initial
  provider.refresh().catch(() => {});
}

export function deactivate() {}
