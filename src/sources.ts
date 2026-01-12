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

async function readJsonc(uri: vscode.Uri): Promise<any | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    return parse(text);
  } catch {
    return undefined;
  }
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
}> {
  const cfg = vscode.workspace.getConfiguration("betterRun");
  const userLaunches = (cfg.get<any[]>("userLaunches") ?? []).filter(Boolean);
  const userTasks = (cfg.get<UserTaskSpec[]>("userTasks") ?? []).filter(Boolean);
  const rules = (cfg.get<CategoryRule[]>("taskCategoryRules") ?? []).filter(Boolean);
  const byLabel = (cfg.get<Record<string, string>>("taskCategoryByLabel") ?? {});

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  const launchSources: SourceRef[] = [];
  const taskSources: SourceRef[] = [];
  const launches: LaunchItem[] = [];
  const tasks: TaskItem[] = [];

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

  return { launchSources, launches, taskSources, tasks };
}
