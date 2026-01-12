import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BetterRunTreeProvider } from "./tree";
import type { LaunchItem, TaskItem, NotebookItem } from "./sources";
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

// Create output channel for debugging
let outputChannel: vscode.OutputChannel | undefined;

// Track last executed items for rerun commands
let lastDebugLaunch: LaunchItem | undefined;
let lastRunLaunch: LaunchItem | undefined;
let lastTask: TaskItem | undefined;

async function executeDebugLaunch(
  item: LaunchItem,
  provider: BetterRunTreeProvider,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!item?.config) return;

  // Track as last debug launch
  lastDebugLaunch = item;

  // Set loading state
  provider.setLaunchRunning(item.id, true);

  // Use the config object directly (works even if it's NOT in launch.json)
  const cfg = { ...item.config };

  // Make sure it has a name (VS Code uses this in UI)
  cfg.name = cfg.name || item.name;

  const folder = item.workspaceFolder; // undefined allowed (user/global)
  
  // Set up session tracking BEFORE starting debugging
  let sessionMatched = false;
  const terminateDisposable = vscode.debug.onDidTerminateDebugSession((terminated) => {
    // Check if this session matches our launch
    if (terminated.name === item.name || terminated.configuration?.name === item.name) {
      provider.setLaunchRunning(item.id, false);
      sessionMatched = true;
      terminateDisposable.dispose();
      startDisposable.dispose();
    }
  });
  
  const startDisposable = vscode.debug.onDidStartDebugSession((session) => {
    // Mark that we found a matching session
    if (session.name === item.name || session.configuration?.name === item.name) {
      sessionMatched = true;
    }
  });
  
  context.subscriptions.push(terminateDisposable, startDisposable);

  const ok = await vscode.debug.startDebugging(folder, cfg);

  if (!ok) {
    provider.setLaunchRunning(item.id, false);
    terminateDisposable.dispose();
    startDisposable.dispose();
    vscode.window.showErrorMessage(`Failed to debug '${item.name}'.`);
  } else {
    // Fallback: if no session starts within 3 seconds, clear loading state
    setTimeout(() => {
      if (!sessionMatched) {
        const session = vscode.debug.activeDebugSession;
        if (!session || (session.name !== item.name && session.configuration?.name !== item.name)) {
          provider.setLaunchRunning(item.id, false);
        }
      }
    }, 3000);
  }
}

async function executeRunLaunch(
  item: LaunchItem,
  provider: BetterRunTreeProvider,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!item?.config) return;

  // Track as last run launch
  lastRunLaunch = item;

  // Set loading state
  provider.setLaunchRunning(item.id, true);

  const cfg = { ...item.config, name: item.name, noDebug: true };
  const folder = item.workspaceFolder; // undefined allowed (user/global)
  
  // Set up session tracking BEFORE starting
  let sessionMatched = false;
  const terminateDisposable = vscode.debug.onDidTerminateDebugSession((terminated) => {
    // Check if this session matches our launch
    if (terminated.name === item.name || terminated.configuration?.name === item.name) {
      provider.setLaunchRunning(item.id, false);
      sessionMatched = true;
      terminateDisposable.dispose();
      startDisposable.dispose();
    }
  });
  
  const startDisposable = vscode.debug.onDidStartDebugSession((session) => {
    // Mark that we found a matching session
    if (session.name === item.name || session.configuration?.name === item.name) {
      sessionMatched = true;
    }
  });
  
  context.subscriptions.push(terminateDisposable, startDisposable);

  const ok = await vscode.debug.startDebugging(folder, cfg);
  if (!ok) {
    provider.setLaunchRunning(item.id, false);
    terminateDisposable.dispose();
    startDisposable.dispose();
    vscode.window.showErrorMessage(`Failed to run '${item.name}'.`);
  } else {
    // Fallback: if no session starts within 3 seconds, clear loading state
    setTimeout(() => {
      if (!sessionMatched) {
        const session = vscode.debug.activeDebugSession;
        if (!session || (session.name !== item.name && session.configuration?.name !== item.name)) {
          provider.setLaunchRunning(item.id, false);
        }
      }
    }, 3000);
  }
}

async function executeTask(
  item: TaskItem,
  provider: BetterRunTreeProvider,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!item) return;

  // Track as last task
  lastTask = item;

  // Set loading state
  provider.setTaskRunning(item.id, true);

  // User settings tasks: run via terminal
  if (item.userTask) {
    const isWindows = process.platform === 'win32';
    const tmpDir = os.tmpdir();
    const markerFile = path.join(tmpDir, `better-run-${item.id.replace(/[^a-zA-Z0-9]/g, '-')}.done`);
    
    // Create terminal with a unique name to track it
    const terminalName = `Better Run: ${item.userTask.label}`;
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: item.userTask.cwd,
    });
    terminal.show(true);
    
    // Wrap command to write completion marker when done
    // This allows us to detect when the process actually finishes
    let wrappedCommand: string;
    if (isWindows) {
      // Windows: run command, then create marker file
      wrappedCommand = `${item.userTask.command} && echo. > "${markerFile}"`;
    } else {
      // Unix/macOS: run command, then create marker file
      wrappedCommand = `(${item.userTask.command}); touch "${markerFile}"`;
    }
    
    // Clean up any existing marker file
    try {
      if (fs.existsSync(markerFile)) {
        fs.unlinkSync(markerFile);
      }
    } catch {
      // Ignore errors
    }
    
    // Send the wrapped command
    terminal.sendText(wrappedCommand, true);
    
    // Poll for completion marker file
    const clearLoadingState = () => {
      provider.setTaskRunning(item.id, false);
      // Clean up marker file
      try {
        if (fs.existsSync(markerFile)) {
          fs.unlinkSync(markerFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    };
    
    // Poll for marker file every 500ms
    let pollCount = 0;
    const maxPolls = 600; // Poll for up to 5 minutes (600 * 500ms)
    const pollInterval = setInterval(() => {
      pollCount++;
      
      try {
        if (fs.existsSync(markerFile)) {
          // Marker file exists - command completed!
          clearInterval(pollInterval);
          clearLoadingState();
          return;
        }
      } catch {
        // Ignore file check errors
      }
      
      // Fallback: stop polling after max attempts
      if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        clearLoadingState();
      }
    }, 500);
    
    // Also listen for terminal close as a backup
    const closeDisposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) {
        clearInterval(pollInterval);
        clearLoadingState();
        closeDisposable.dispose();
      }
    });
    context.subscriptions.push(closeDisposable);
    
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
    provider.setTaskRunning(item.id, false);
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

  // Track task execution - set up BEFORE executing
  let taskMatched = false;
  const taskEndDisposable = vscode.tasks.onDidEndTask((endEvent) => {
    // Check if this task matches
    const taskName = endEvent.execution.task.name;
    const taskLabel = (endEvent.execution.task.definition as any)?.label;
    if (taskName === label || taskLabel === label) {
      provider.setTaskRunning(item.id, false);
      taskMatched = true;
      taskEndDisposable.dispose();
      taskStartDisposable.dispose();
    }
  });
  
  const taskStartDisposable = vscode.tasks.onDidStartTask((e) => {
    // Mark that we found a matching task
    const taskName = e.execution.task.name;
    const taskLabel = (e.execution.task.definition as any)?.label;
    if (taskName === label || taskLabel === label) {
      taskMatched = true;
    }
  });
  
  context.subscriptions.push(taskStartDisposable, taskEndDisposable);

  await vscode.tasks.executeTask(best);
  
  // Fallback: clear loading state after 60 seconds if task doesn't end
  setTimeout(() => {
    if (!taskMatched) {
      provider.setTaskRunning(item.id, false);
    }
  }, 60000);
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Better Run");
  outputChannel.appendLine("Better Run extension activated");
  context.subscriptions.push(outputChannel);
  
  const storage = new Storage(context);

  const provider = new BetterRunTreeProvider(storage, context);

  // IMPORTANT: createTreeView gives you TreeView API + built-in collapse-all button support
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true, // adds the collapse-all button in the view title
  });

  context.subscriptions.push(treeView);

  // Register a no-op command to prevent default click behavior
  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.noop", () => {
      // Do nothing - this prevents default click behavior
    })
  );

  // Double-click detection for launches and tasks
  // Note: onDidChangeSelection returns the data nodes directly
  type Node = 
    | { kind: "launchTop"; item: LaunchItem }
    | { kind: "launch"; item: LaunchItem }
    | { kind: "taskTop"; item: TaskItem }
    | { kind: "task"; item: TaskItem }
    | { kind: string; [key: string]: any };
  
  let lastSelection: { nodeId: string; timestamp: number } | undefined;
  let clickTimeout: NodeJS.Timeout | undefined;
  const DOUBLE_CLICK_DELAY = 300; // milliseconds

  context.subscriptions.push(
    treeView.onDidChangeSelection(async (e) => {
      if (e.selection.length === 0) {
        // Clear selection tracking when nothing is selected
        lastSelection = undefined;
        if (clickTimeout) {
          clearTimeout(clickTimeout);
          clickTimeout = undefined;
        }
        return;
      }
      
      const node = e.selection[0] as Node;
      
      if (!node) return;
      
      // Only handle launches and tasks
      if (node.kind !== "launch" && node.kind !== "launchTop" && 
          node.kind !== "task" && node.kind !== "taskTop") {
        return;
      }
      
      // Get the item ID for comparison
      const nodeId = node.item?.id;
      if (!nodeId) return;
      
      const now = Date.now();
      
      // Clear any pending single-click timeout
      if (clickTimeout) {
        clearTimeout(clickTimeout);
        clickTimeout = undefined;
      }
      
      // Check if this is a double-click (same item selected within the delay window)
      if (lastSelection && 
          lastSelection.nodeId === nodeId && 
          (now - lastSelection.timestamp) < DOUBLE_CLICK_DELAY) {
        
        // This is a double-click - execute the command
        lastSelection = undefined;
        
        // Handle double-click based on item type
        if (node.kind === "launch" || node.kind === "launchTop") {
          // For launches, default to run (not debug) on double-click
          await executeRunLaunch(node.item, provider, context);
        } else if (node.kind === "task" || node.kind === "taskTop") {
          // For tasks, run the task
          await executeTask(node.item, provider, context);
        }
      } else {
        // This is a single click - just track it, don't execute
        lastSelection = { nodeId: nodeId, timestamp: now };
        
        // Set a timeout to clear the selection after the double-click window
        clickTimeout = setTimeout(() => {
          lastSelection = undefined;
          clickTimeout = undefined;
        }, DOUBLE_CLICK_DELAY);
      }
    })
  );



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
      await executeDebugLaunch(item, provider, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.runLaunch", async (arg: LaunchArg) => {
      const item = unwrapLaunch(arg);
      if (!item?.config) return;
      await executeRunLaunch(item, provider, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.runTask", async (arg: TaskArg) => {
      const item = unwrapTask(arg);
      if (!item) return;
      await executeTask(item, provider, context);
    })
  );

  // Rerun commands
  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.rerunLastTask", async () => {
      if (!lastTask) {
        vscode.window.showInformationMessage("No task has been run yet.");
        return;
      }
      await executeTask(lastTask, provider, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.rerunLastLaunch", async () => {
      if (!lastRunLaunch) {
        vscode.window.showInformationMessage("No launch has been run yet.");
        return;
      }
      await executeRunLaunch(lastRunLaunch, provider, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.redebugLastLaunch", async () => {
      if (!lastDebugLaunch) {
        vscode.window.showInformationMessage("No launch has been debugged yet.");
        return;
      }
      await executeDebugLaunch(lastDebugLaunch, provider, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.openNotebook", async (arg: NotebookItem | { item: NotebookItem }) => {
      const item = (arg && typeof arg === 'object' && 'uri' in arg) ? arg as NotebookItem : (arg as any)?.item;
      if (!item?.uri) return;

      try {
        // Open notebook in the default notebook editor
        const notebook = await vscode.workspace.openNotebookDocument(item.uri);
        await vscode.window.showNotebookDocument(notebook, { preview: false });
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open notebook: ${item.name}`);
      }
    })
  );

  // Listen for configuration changes to refresh notebooks
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("betterRun.userNotebookPaths")) {
        provider.refresh().catch(() => {});
      }
    })
  );

  // initial
  provider.refresh().catch(() => {});
}

export function deactivate() {}
