import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BetterRunTreeProvider } from "./tree";
import type { LaunchItem, TaskItem, NotebookItem } from "./sources";
import { loadLaunchesAndTasks } from "./sources";
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
let lastLaunch: LaunchItem | undefined; // Shared pool for both run and debug
let lastTask: TaskItem | undefined;

async function executeDebugLaunch(
  item: LaunchItem,
  provider: BetterRunTreeProvider,
  context: vscode.ExtensionContext
): Promise<void> {
  if (!item?.config) return;

  // Track as last launch (shared pool for both run and debug)
  lastLaunch = item;

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

  // Track as last launch (shared pool for both run and debug)
  lastLaunch = item;

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
      if (!lastLaunch) {
        vscode.window.showInformationMessage("No launch has been run or debugged yet.");
        return;
      }
      await executeRunLaunch(lastLaunch, provider, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.redebugLastLaunch", async () => {
      if (!lastLaunch) {
        vscode.window.showInformationMessage("No launch has been run or debugged yet.");
        return;
      }
      await executeDebugLaunch(lastLaunch, provider, context);
    })
  );

  // Helper function to create a launch configuration for a file
  async function createLaunchConfigForFile(fileUri: vscode.Uri, languageId?: string): Promise<any> {
    const fileName = fileUri.fsPath.split(/[/\\]/).pop() || "file";
    const fileExtension = fileName.split('.').pop()?.toLowerCase() || "";

    // Create a launch configuration based on file type
    let launchConfig: any = {
      name: `${fileName}`,
      type: "node", // default
      request: "launch",
      program: fileUri.fsPath,
      console: "integratedTerminal"
    };

    // Detect appropriate launch type based on language or extension
    if (languageId === "python" || fileExtension === "py") {
      launchConfig = {
        name: `Python: ${fileName}`,
        type: "python",
        request: "launch",
        program: fileUri.fsPath,
        console: "integratedTerminal",
        justMyCode: true
      };
    } else if (languageId === "javascript" || languageId === "typescript" || 
               fileExtension === "js" || fileExtension === "ts" || fileExtension === "mjs" || fileExtension === "cjs") {
      launchConfig = {
        name: `Node: ${fileName}`,
        type: "node",
        request: "launch",
        program: fileUri.fsPath,
        console: "integratedTerminal"
      };
    } else if (languageId === "go" || fileExtension === "go") {
      launchConfig = {
        name: `Go: ${fileName}`,
        type: "go",
        request: "launch",
        mode: "debug",
        program: fileUri.fsPath
      };
    } else if (languageId === "rust" || fileExtension === "rs") {
      launchConfig = {
        name: `Rust: ${fileName}`,
        type: "lldb",
        request: "launch",
        program: "${workspaceFolder}/target/debug/${fileBasenameNoExtension}",
        args: [],
        cwd: "${workspaceFolder}"
      };
    } else if (languageId === "java" || fileExtension === "java") {
      launchConfig = {
        name: `Java: ${fileName}`,
        type: "java",
        request: "launch",
        mainClass: "${file}",
        projectName: "${workspaceFolder}"
      };
    } else {
      // Generic fallback - ask user for type
      const launchType = await vscode.window.showInputBox({
        prompt: "Enter launch type (e.g., 'python', 'node', 'go')",
        placeHolder: "node",
        value: "node"
      });
      if (!launchType) return undefined;

      launchConfig = {
        name: `${launchType}: ${fileName}`,
        type: launchType,
        request: "launch",
        program: fileUri.fsPath,
        console: "integratedTerminal"
      };
    }

    return launchConfig;
  }

  // Helper function to find or create a launch for a file
  async function findOrCreateLaunchForFile(fileUri: vscode.Uri): Promise<LaunchItem | undefined> {
    const fileName = fileUri.fsPath.split(/[/\\]/).pop() || "file";
    const languageId = vscode.window.activeTextEditor?.document.languageId;

    // First, check if a launch already exists by loading all launches
    const { launches } = await loadLaunchesAndTasks();
    const existingLaunchItem = launches.find((l: LaunchItem) => {
      // Check if the launch config program matches the file path
      const configProgram = l.config?.program;
      if (configProgram === fileUri.fsPath) {
        return true;
      }
      // Also check if name matches the file (for cases where program might be different)
      if (l.name && (l.name.includes(fileName) || l.name === fileName)) {
        return true;
      }
      return false;
    });

    if (existingLaunchItem) {
      return existingLaunchItem;
    }

    // Create a new launch configuration
    const launchConfig = await createLaunchConfigForFile(fileUri, languageId);
    if (!launchConfig) return undefined;

    // Get current user launches and add the new one
    const config = vscode.workspace.getConfiguration("betterRun");
    const currentLaunches = config.get<any[]>("userLaunches") || [];
    const updatedLaunches = [...currentLaunches, launchConfig];

    // Update the configuration
    await config.update("userLaunches", updatedLaunches, vscode.ConfigurationTarget.Global);

    // Refresh the tree view
    await provider.refresh();

    // Wait a bit for the refresh to complete, then find the new launch
    await new Promise(resolve => setTimeout(resolve, 200));
    const { launches: refreshedLaunches } = await loadLaunchesAndTasks();
    const newLaunchItem = refreshedLaunches.find((l: LaunchItem) => 
      l.config?.program === launchConfig.program && l.name === launchConfig.name
    );

    return newLaunchItem;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.runFileAsLaunch", async (uri?: vscode.Uri) => {
      // Get the file URI - either from the command argument or the active editor
      let fileUri: vscode.Uri | undefined;
      if (uri) {
        fileUri = uri;
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          fileUri = activeEditor.document.uri;
        }
      }

      if (!fileUri) {
        vscode.window.showErrorMessage("No file is open or selected.");
        return;
      }

      // Only work with file:// URIs
      if (fileUri.scheme !== "file") {
        vscode.window.showErrorMessage("Only local files can be run as launches.");
        return;
      }

      const launchItem = await findOrCreateLaunchForFile(fileUri);
      if (!launchItem) {
        vscode.window.showErrorMessage("Failed to create or find launch configuration.");
        return;
      }

      await executeRunLaunch(launchItem, provider, context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.debugFileAsLaunch", async (uri?: vscode.Uri) => {
      // Get the file URI - either from the command argument or the active editor
      let fileUri: vscode.Uri | undefined;
      if (uri) {
        fileUri = uri;
      } else {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          fileUri = activeEditor.document.uri;
        }
      }

      if (!fileUri) {
        vscode.window.showErrorMessage("No file is open or selected.");
        return;
      }

      // Only work with file:// URIs
      if (fileUri.scheme !== "file") {
        vscode.window.showErrorMessage("Only local files can be debugged as launches.");
        return;
      }

      const launchItem = await findOrCreateLaunchForFile(fileUri);
      if (!launchItem) {
        vscode.window.showErrorMessage("Failed to create or find launch configuration.");
        return;
      }

      await executeDebugLaunch(launchItem, provider, context);
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

  // Helper function to find Python virtual environments
  async function findPythonVenvs(): Promise<string[]> {
    const venvs: string[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    const home = os.homedir();

    // Common venv locations
    const searchPaths: string[] = [];

    // Workspace folders
    for (const folder of workspaceFolders) {
      searchPaths.push(path.join(folder.uri.fsPath, '.venv'));
      searchPaths.push(path.join(folder.uri.fsPath, 'venv'));
      searchPaths.push(path.join(folder.uri.fsPath, 'env'));
      searchPaths.push(path.join(folder.uri.fsPath, '.env'));
    }

    // Common system locations
    if (process.platform === 'win32') {
      searchPaths.push(path.join(home, '.virtualenvs'));
    } else {
      searchPaths.push(path.join(home, '.virtualenvs'));
      searchPaths.push(path.join(home, '.pyenv', 'versions'));
      searchPaths.push('/usr/local/bin');
      searchPaths.push('/opt/homebrew/bin');
    }

    // Check each path
    for (const searchPath of searchPaths) {
      try {
        if (fs.existsSync(searchPath)) {
          const stat = fs.statSync(searchPath);
          if (stat.isDirectory()) {
            // Check if it's a venv (has bin/python or Scripts/python.exe)
            const pythonPath = process.platform === 'win32' 
              ? path.join(searchPath, 'Scripts', 'python.exe')
              : path.join(searchPath, 'bin', 'python');
            if (fs.existsSync(pythonPath)) {
              venvs.push(searchPath);
            } else {
              // Check for subdirectories (like pyenv versions)
              try {
                const entries = fs.readdirSync(searchPath);
                for (const entry of entries) {
                  const entryPath = path.join(searchPath, entry);
                  const entryStat = fs.statSync(entryPath);
                  if (entryStat.isDirectory()) {
                    const subPythonPath = process.platform === 'win32'
                      ? path.join(entryPath, 'Scripts', 'python.exe')
                      : path.join(entryPath, 'bin', 'python');
                    if (fs.existsSync(subPythonPath)) {
                      venvs.push(entryPath);
                    }
                  }
                }
              } catch {
                // Ignore readdir errors
              }
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }

    // Also check for conda environments
    if (process.platform !== 'win32') {
      const condaPath = path.join(home, 'anaconda3', 'envs');
      if (fs.existsSync(condaPath)) {
        try {
          const entries = fs.readdirSync(condaPath);
          for (const entry of entries) {
            venvs.push(path.join(condaPath, entry));
          }
        } catch {
          // Ignore errors
        }
      }
    }

    return venvs;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.attachVenv", async (arg: LaunchArg | TaskArg) => {
      const launchItem = unwrapLaunch(arg as LaunchArg);
      const taskItem = unwrapTask(arg as TaskArg);
      
      if (!launchItem && !taskItem) {
        vscode.window.showErrorMessage("No launch or task selected.");
        return;
      }

      const item = launchItem || taskItem;
      const isPython = launchItem 
        ? launchItem.config?.type === "python"
        : taskItem?.userTask?.command?.includes("python") || false;

      if (!isPython) {
        vscode.window.showInformationMessage("Attach venv is only available for Python launches and tasks.");
        return;
      }

      // Find available venvs
      const venvs = await findPythonVenvs();
      
      if (venvs.length === 0) {
        const customPath = await vscode.window.showInputBox({
          prompt: "No virtual environments found. Enter the path to a Python virtual environment:",
          placeHolder: "/path/to/venv"
        });
        if (!customPath) return;

        const pythonPath = process.platform === 'win32'
          ? path.join(customPath, 'Scripts', 'python.exe')
          : path.join(customPath, 'bin', 'python');
        
        if (!fs.existsSync(pythonPath)) {
          vscode.window.showErrorMessage(`Python executable not found at ${pythonPath}`);
          return;
        }

        // Update the launch/task with the venv
        if (launchItem) {
          const config = vscode.workspace.getConfiguration("betterRun");
          const currentLaunches = config.get<any[]>("userLaunches") || [];
          const launchIndex = currentLaunches.findIndex((l: any) => 
            l.name === launchItem.name && l.program === launchItem.config.program
          );
          
          if (launchIndex >= 0) {
            currentLaunches[launchIndex].python = pythonPath;
            await config.update("userLaunches", currentLaunches, vscode.ConfigurationTarget.Global);
            await provider.refresh();
            vscode.window.showInformationMessage(`Attached venv to "${launchItem.name}"`);
          }
        }
        return;
      }

      // Show quick pick for venv selection
      const venvOptions = venvs.map(venv => ({
        label: path.basename(venv),
        description: venv,
        venvPath: venv
      }));

      const selected = await vscode.window.showQuickPick(venvOptions, {
        placeHolder: "Select a Python virtual environment"
      });

      if (!selected) return;

      const pythonPath = process.platform === 'win32'
        ? path.join(selected.venvPath, 'Scripts', 'python.exe')
        : path.join(selected.venvPath, 'bin', 'python');

      // Update the launch/task with the venv
      if (launchItem) {
        const config = vscode.workspace.getConfiguration("betterRun");
        const currentLaunches = config.get<any[]>("userLaunches") || [];
        const launchIndex = currentLaunches.findIndex((l: any) => 
          l.name === launchItem.name && l.program === launchItem.config.program
        );
        
        if (launchIndex >= 0) {
          currentLaunches[launchIndex].python = pythonPath;
          await config.update("userLaunches", currentLaunches, vscode.ConfigurationTarget.Global);
          await provider.refresh();
          vscode.window.showInformationMessage(`Attached venv to "${launchItem.name}"`);
        } else {
          vscode.window.showWarningMessage("Could not find launch in user settings. Only user settings launches can be modified.");
        }
      } else if (taskItem && taskItem.userTask) {
        const config = vscode.workspace.getConfiguration("betterRun");
        const currentTasks = config.get<any[]>("userTasks") || [];
        const taskIndex = currentTasks.findIndex((t: any) => 
          t.label === taskItem.label
        );
        
        if (taskIndex >= 0) {
          // Update task command to use the venv python
          const originalCommand = currentTasks[taskIndex].command;
          currentTasks[taskIndex].command = `"${pythonPath}" -m ${originalCommand.replace(/^python\s+-m\s+/, '').replace(/^python\s+/, '')}`;
          await config.update("userTasks", currentTasks, vscode.ConfigurationTarget.Global);
          await provider.refresh();
          vscode.window.showInformationMessage(`Attached venv to "${taskItem.label}"`);
        } else {
          vscode.window.showWarningMessage("Could not find task in user settings. Only user settings tasks can be modified.");
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("betterRun.goToSettingsDefinition", async (arg: LaunchArg | TaskArg) => {
      const launchItem = unwrapLaunch(arg as LaunchArg);
      const taskItem = unwrapTask(arg as TaskArg);
      
      if (!launchItem && !taskItem) {
        vscode.window.showErrorMessage("No launch or task selected.");
        return;
      }

      const item = launchItem || taskItem;
      const source = launchItem?.source || taskItem?.source;

      if (!source) {
        vscode.window.showErrorMessage("Could not find source for this item.");
        return;
      }

      // If it's from user settings, open settings.json
      if (source.isUserSettings && source.uri) {
        try {
          const document = await vscode.workspace.openTextDocument(source.uri);
          await vscode.window.showTextDocument(document);
          
          // Try to find and highlight the item
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const text = document.getText();
            const searchName = launchItem ? launchItem.name : taskItem?.label;
            if (searchName) {
              const lines = text.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`"${searchName}"`) || lines[i].includes(`'${searchName}'`)) {
                  const position = new vscode.Position(i, 0);
                  const range = new vscode.Range(position, position);
                  editor.revealRange(range, vscode.TextEditorRevealType.Default);
                  editor.selection = new vscode.Selection(position, position);
                  break;
                }
              }
            }
          }
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open settings file: ${error}`);
        }
      } else if (source.uri) {
        // For workspace files (launch.json, tasks.json), open the file
        try {
          const document = await vscode.workspace.openTextDocument(source.uri);
          await vscode.window.showTextDocument(document);
          
          // Try to find and highlight the item
          const searchName = launchItem ? launchItem.name : taskItem?.label;
          if (searchName) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              const text = document.getText();
              const lines = text.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`"${searchName}"`) || lines[i].includes(`'${searchName}'`)) {
                  const position = new vscode.Position(i, 0);
                  const range = new vscode.Range(position, position);
                  editor.revealRange(range, vscode.TextEditorRevealType.Default);
                  editor.selection = new vscode.Selection(position, position);
                  break;
                }
              }
            }
          }
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open definition file: ${error}`);
        }
      } else {
        vscode.window.showInformationMessage("This item is from a built-in source and cannot be opened.");
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
