import * as vscode from "vscode";
import { parse } from "jsonc-parser";

export type SectionKind = "launches" | "tasks";

export interface SourceRef {
  id: string;
  label: string;
  uri?: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  kind: SectionKind;
  isUserSettings?: boolean;
}

export interface LaunchItem {
  id: string;
  name: string;
  category?: string;
  config: any;
  workspaceFolder?: vscode.WorkspaceFolder;
  source: SourceRef;
}

export interface CategoryRule {
  category: string;
  pattern: string;
}

export interface UserTaskSpec {
  label: string;
  type?: "shell";
  command: string;
  cwd?: string;
  category?: string;
}

export interface TaskItem {
  id: string;
  label: string;
  category?: string;
  workspaceFolder?: vscode.WorkspaceFolder;
  userTask?: UserTaskSpec;
  source: SourceRef;
}

export interface NotebookItem {
  id: string;
  name: string;
  uri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  isLocal?: boolean;
}

async function readJsonc(uri: vscode.Uri): Promise<any | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    return parse(text);
  } catch {
    return undefined;
  }
}

async function resolveNotebookPath(path: string, baseUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  try {
    // If path is absolute, use it directly
    if (path.startsWith('/') || (process.platform === 'win32' && /^[A-Za-z]:/.test(path))) {
      return vscode.Uri.file(path);
    }
    // If path is relative and we have a base URI, resolve relative to it
    if (baseUri) {
      return vscode.Uri.joinPath(baseUri, path);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function loadNotebooksFromPath(notebookPath: string, workspaceFolder?: vscode.WorkspaceFolder, isLocal?: boolean): Promise<NotebookItem[]> {
  const notebooks: NotebookItem[] = [];
  try {
    const baseUri = workspaceFolder?.uri;
    const uri = await resolveNotebookPath(notebookPath, baseUri);
    if (!uri) {
      return notebooks;
    }

    const stat = await vscode.workspace.fs.stat(uri);
    
    // If it's a file and ends with .ipynb, add it directly
    if (stat.type === vscode.FileType.File && uri.fsPath.endsWith('.ipynb')) {
      const baseName = uri.fsPath.split(/[/\\]/).pop()?.replace(/\.ipynb$/, '') || 'notebook';
      notebooks.push({
        id: `notebook::${uri.toString()}`,
        name: baseName,
        uri: uri,
        workspaceFolder,
        isLocal,
      });
      return notebooks;
    }
    
    // If it's a directory, search for .ipynb files in it (non-recursive)
    if (stat.type === vscode.FileType.Directory) {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.endsWith('.ipynb')) {
          const notebookUri = vscode.Uri.joinPath(uri, name);
          const baseName = name.replace(/\.ipynb$/, '');
          notebooks.push({
            id: `notebook::${notebookUri.toString()}`,
            name: baseName,
            uri: notebookUri,
            workspaceFolder,
            isLocal,
          });
        }
      }
    }
  } catch (error) {
    // Ignore errors (path doesn't exist, permission denied, etc.)
    const outputChannel = vscode.window.createOutputChannel("Better Run");
    outputChannel.appendLine(`Better Run: Could not load notebook from path: ${notebookPath} - ${error}`);
  }
  return notebooks;
}

function getUserSettingsUris(): vscode.Uri[] {
  const home = process.env.HOME ?? "";
  const candidates = [
    `${home}/Library/Application Support/Cursor/User/settings.json`,
    `${home}/Library/Application Support/Code/User/settings.json`,
  ].filter(Boolean);

  return candidates.map((p) => vscode.Uri.file(p));
}

async function firstExistingUri(uris: vscode.Uri[]): Promise<vscode.Uri | undefined> {
  for (const u of uris) {
    try {
      await vscode.workspace.fs.stat(u);
      return u;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function resolveTaskCategory(label: string, rules: CategoryRule[], byLabel: Record<string, string>): string | undefined {
  const exact = byLabel[label];
  if (exact && exact.trim()) return exact.trim();

  for (const r of rules) {
    try {
      const re = new RegExp(r.pattern, "i");
      if (re.test(label)) return r.category;
    } catch {
      // ignore invalid regex
    }
  }

  // Optional fallback: treat "X: ..." as category
  const m = label.match(/^([^:]+):\s*/);
  if (m?.[1]) return m[1].trim();

  return undefined; // <-- key change: no category means "top level"
}

function resolveLaunchCategory(name: string, rules: CategoryRule[], byLabel: Record<string, string>): string | undefined {
  const exact = byLabel[name];
  if (exact && exact.trim()) return exact.trim();

  for (const r of rules) {
    try {
      const re = new RegExp(r.pattern, "i");
      if (re.test(name)) return r.category;
    } catch {
      // ignore invalid regex
    }
  }

  // Optional fallback: treat "X: ..." as category
  const m = name.match(/^([^:]+):\s*/);
  if (m?.[1]) return m[1].trim();

  return undefined;
}


function categorizeTaskLabel(label: string, rules: CategoryRule[]): string {
  for (const r of rules) {
    try {
      const re = new RegExp(r.pattern, "i");
      if (re.test(label)) return r.category;
    } catch {
      // invalid regex -> ignore
    }
  }

  const m = label.match(/^([^:]+):\s*/);
  if (m?.[1]) return m[1].trim();

  return "Other";
}

export async function loadLaunchesAndTasks(): Promise<{
  launchSources: SourceRef[];
  launches: LaunchItem[];
  taskSources: SourceRef[];
  tasks: TaskItem[];
  notebooks: NotebookItem[];
}> {
  const cfg = vscode.workspace.getConfiguration("betterRun");
  const userLaunches = (cfg.get<any[]>("userLaunches") ?? []).filter(Boolean);
  const userTasks = (cfg.get<UserTaskSpec[]>("userTasks") ?? []).filter(Boolean);
  const rules = (cfg.get<CategoryRule[]>("taskCategoryRules") ?? []).filter(Boolean);
  const byLabel = (cfg.get<Record<string, string>>("taskCategoryByLabel") ?? {});
  const userNotebookPaths = (cfg.get<string[]>("userNotebookPaths") ?? []).filter(Boolean);
  
  const outputChannel = vscode.window.createOutputChannel("Better Run");
  if (userNotebookPaths.length > 0) {
    outputChannel.appendLine(`Better Run: Found ${userNotebookPaths.length} user notebook paths`);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  const launchSources: SourceRef[] = [];
  const taskSources: SourceRef[] = [];
  const launches: LaunchItem[] = [];
  const tasks: TaskItem[] = [];
  const notebooks: NotebookItem[] = [];

  // Workspace launch.json
  for (const wf of workspaceFolders) {
    const uri = vscode.Uri.joinPath(wf.uri, ".vscode", "launch.json");
    const json = await readJsonc(uri);
    if (json && Array.isArray(json.configurations)) {
      const source: SourceRef = {
        id: `launch::${uri.toString()}`,
        label: `launch.json`,
        uri,
        workspaceFolder: wf,
        kind: "launches",
      };
      launchSources.push(source);

      for (const c of json.configurations as any[]) {
        const name = String(c?.name ?? "").trim();
        if (!name) continue;
        
        // Resolve category: explicit category field, or pattern matching
        const category = (c?.category && String(c.category).trim()) 
          ? String(c.category).trim() 
          : resolveLaunchCategory(name, rules, byLabel);
        
        launches.push({
          id: `${source.id}::${name}`,
          name,
          category,
          config: c,
          workspaceFolder: wf,
          source,
        });
      }
    }
  }

  // Workspace tasks.json
  for (const wf of workspaceFolders) {
    const uri = vscode.Uri.joinPath(wf.uri, ".vscode", "tasks.json");
    const json = await readJsonc(uri);
    if (json && Array.isArray(json.tasks)) {
      const source: SourceRef = {
        id: `task::${uri.toString()}`,
        label: `tasks.json`,
        uri,
        workspaceFolder: wf,
        kind: "tasks",
      };
      taskSources.push(source);

      for (const t of json.tasks as any[]) {
        const label = String(t?.label ?? "").trim();
        if (!label) continue;

        const category = resolveTaskCategory(label, rules, byLabel);

        tasks.push({
          id: `${source.id}::${label}`,
          label,
          category,
          workspaceFolder: wf,
          source,
        });
      }
    }
  }

  // User settings.json as a source
  const userSettingsUri = await firstExistingUri(getUserSettingsUris());
  if (userSettingsUri) {
    if (userLaunches.length) {
      const source: SourceRef = {
        id: `launch::usersettings::${userSettingsUri.toString()}`,
        label: `User settings`,
        uri: userSettingsUri,
        kind: "launches",
        isUserSettings: true,
      };
      
      launchSources.push(source);
      for (const c of userLaunches) {
        const name = String(c?.name ?? "").trim();
        if (!name) continue;
        
        // Resolve category: explicit category field, or pattern matching
        const category = (c?.category && String(c.category).trim()) 
          ? String(c.category).trim() 
          : resolveLaunchCategory(name, rules, byLabel);
        
        launches.push({
          id: `${source.id}::${name}`,
          name,
          category,
          config: c,
          source,
        });
      }
    }

    if (userTasks.length) {
      const source: SourceRef = {
        id: `task::usersettings::${userSettingsUri.toString()}`,
        label: `User settings`,
        uri: userSettingsUri,
        kind: "tasks",
        isUserSettings: true,
      };
      taskSources.push(source);

      for (const t of userTasks) {
        const label = String(t?.label ?? "").trim();
        if (!label) continue;

        const category =
          (t.category && String(t.category).trim()) || resolveTaskCategory(label, rules, byLabel);



        tasks.push({
          id: `${source.id}::${label}`,
          label,
          category,
          userTask: t,
          source,
        });
      }
    }
  }

  // Find notebooks from workspace notebooks.json files
  for (const wf of workspaceFolders) {
    const notebooksJsonUri = vscode.Uri.joinPath(wf.uri, ".vscode", "notebooks.json");
    const notebooksJson = await readJsonc(notebooksJsonUri);
    if (notebooksJson && Array.isArray(notebooksJson.paths)) {
      outputChannel.appendLine(`Better Run: Found notebooks.json in ${wf.name} with ${notebooksJson.paths.length} paths`);
      for (const path of notebooksJson.paths) {
        if (typeof path === 'string' && path.trim()) {
          const pathNotebooks = await loadNotebooksFromPath(path.trim(), wf, false);
          notebooks.push(...pathNotebooks);
        }
      }
    }
  }

  // Find notebooks from user settings paths
  for (const path of userNotebookPaths) {
    if (typeof path === 'string' && path.trim()) {
      outputChannel.appendLine(`Better Run: Processing user notebook path: "${path.trim()}"`);
      const pathNotebooks = await loadNotebooksFromPath(path.trim(), undefined, true);
      notebooks.push(...pathNotebooks);
    }
  }

  launchSources.sort((a, b) => a.label.localeCompare(b.label));
  taskSources.sort((a, b) => a.label.localeCompare(b.label));
  launches.sort((a, b) => a.source.label.localeCompare(b.source.label) || a.name.localeCompare(b.name));
  tasks.sort((a, b) => {
    const ac = a.category ?? "~";
    const bc = b.category ?? "~";
    return (
      ac.localeCompare(bc) ||
      a.source.label.localeCompare(b.source.label) ||
      a.label.localeCompare(b.label)
    );
  });
  notebooks.sort((a: NotebookItem, b: NotebookItem) => a.name.localeCompare(b.name));

  return { launchSources, launches, taskSources, tasks, notebooks };
}
