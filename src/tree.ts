import * as vscode from "vscode";
import { loadLaunchesAndTasks, LaunchItem, TaskItem, SourceRef } from "./sources";
import { Storage } from "./storage";

type WorkspaceNode = {
  kind: "workspace";
  key: string;
  name: string;
  workspaceFolder?: vscode.WorkspaceFolder;
};

type Node =
  | WorkspaceNode
  | { kind: "section"; workspaceKey: string; section: "Launches" | "Tasks" }
  | { kind: "launch"; item: LaunchItem }
  | { kind: "taskCategory"; workspaceKey: string; category: string }
  | { kind: "taskTop"; item: TaskItem }
  | { kind: "task"; item: TaskItem };

const USER_WORKSPACE_KEY = "ws::user";

function workspaceKeyFromFolder(wf?: vscode.WorkspaceFolder): string {
  return wf ? `ws::${wf.uri.toString()}` : USER_WORKSPACE_KEY;
}

export class BetterRunTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workspaces: WorkspaceNode[] = [];

  // workspaceKey -> tasks[]
  private topLevelTasksByWorkspace: Map<string, TaskItem[]> = new Map();

  // workspaceKey -> sources[]
  private launchSourcesByWorkspace: Map<string, SourceRef[]> = new Map();

  // workspaceKey -> sourceId -> launches[]
  private launchesByWorkspaceAndSource: Map<string, Map<string, LaunchItem[]>> = new Map();

  // workspaceKey -> categories[]
  private taskCategoriesByWorkspace: Map<string, string[]> = new Map();

  // workspaceKey -> category -> sourceId -> tasks[]
  private tasksByWorkspaceCategorySource: Map<string, Map<string, Map<string, TaskItem[]>>> = new Map();

  // workspaceKey -> category -> sources[]
  private taskSourcesByWorkspaceCategory: Map<string, Map<string, SourceRef[]>> = new Map();

  constructor(private readonly storage: Storage) {}

  private getFilterLower(): string {
    return this.storage.getNameFilter().trim().toLowerCase();
  }

  private workspaceHasMatches(workspaceKey: string, filterLower: string): boolean {
    if (!filterLower) return true;

    const launchesBySrc: Map<string, LaunchItem[]> =
      this.launchesByWorkspaceAndSource.get(workspaceKey) ?? new Map<string, LaunchItem[]>();

    const hasLaunchMatch = Array.from(launchesBySrc.values()).some((arr: LaunchItem[]) =>
      arr.some((i: LaunchItem) => i.name.toLowerCase().includes(filterLower))
    );

    const catTasks: Map<string, Map<string, TaskItem[]>> =
      this.tasksByWorkspaceCategorySource.get(workspaceKey) ?? new Map<string, Map<string, TaskItem[]>>();

    const hasTaskMatch = Array.from(catTasks.values()).some((srcMap: Map<string, TaskItem[]>) =>
      Array.from(srcMap.values()).some((arr: TaskItem[]) =>
        arr.some((t: TaskItem) => t.label.toLowerCase().includes(filterLower))
      )
    );

    return hasLaunchMatch || hasTaskMatch;
  }

  private workspaceHasLaunchMatches(workspaceKey: string, filterLower: string): boolean {
    if (!filterLower) return true;

    const launchesBySrc: Map<string, LaunchItem[]> =
      this.launchesByWorkspaceAndSource.get(workspaceKey) ?? new Map<string, LaunchItem[]>();

    return Array.from(launchesBySrc.values()).some((arr: LaunchItem[]) =>
      arr.some((i: LaunchItem) => i.name.toLowerCase().includes(filterLower))
    );
  }

  private workspaceHasTaskMatches(workspaceKey: string, filterLower: string): boolean {
    if (!filterLower) return true;

    const catTasks: Map<string, Map<string, TaskItem[]>> =
      this.tasksByWorkspaceCategorySource.get(workspaceKey) ?? new Map<string, Map<string, TaskItem[]>>();

    return Array.from(catTasks.values()).some((srcMap: Map<string, TaskItem[]>) =>
      Array.from(srcMap.values()).some((arr: TaskItem[]) =>
        arr.some((t: TaskItem) => t.label.toLowerCase().includes(filterLower))
      )
    );
  }

  async refresh(): Promise<void> {
    const { launchSources, launches, taskSources, tasks } = await loadLaunchesAndTasks();

    // Workspaces (plus optional User)
    const ws: WorkspaceNode[] = (vscode.workspace.workspaceFolders ?? []).map((wf) => ({
      kind: "workspace",
      key: workspaceKeyFromFolder(wf),
      name: wf.name,
      workspaceFolder: wf,
    }));

    const hasUser = launchSources.some((s) => !s.workspaceFolder) || taskSources.some((s) => !s.workspaceFolder);
    this.workspaces = [...ws];
    if (hasUser) {
      this.workspaces.push({ kind: "workspace", key: USER_WORKSPACE_KEY, name: "Local" });
    }

    // Launches: workspace -> source -> items
    this.launchSourcesByWorkspace.clear();
    this.launchesByWorkspaceAndSource.clear();

    for (const source of launchSources) {
      const wk = workspaceKeyFromFolder(source.workspaceFolder);

      const list: SourceRef[] = this.launchSourcesByWorkspace.get(wk) ?? [];
      list.push(source);
      this.launchSourcesByWorkspace.set(wk, list);

      const bySource: Map<string, LaunchItem[]> =
        this.launchesByWorkspaceAndSource.get(wk) ?? new Map<string, LaunchItem[]>();
      if (!bySource.has(source.id)) bySource.set(source.id, []);
      this.launchesByWorkspaceAndSource.set(wk, bySource);
    }

    for (const l of launches) {
      const wk = workspaceKeyFromFolder(l.workspaceFolder);
      const bySource: Map<string, LaunchItem[]> =
        this.launchesByWorkspaceAndSource.get(wk) ?? new Map<string, LaunchItem[]>();
      const arr: LaunchItem[] = bySource.get(l.source.id) ?? [];
      arr.push(l);
      bySource.set(l.source.id, arr);
      this.launchesByWorkspaceAndSource.set(wk, bySource);
    }

    for (const bySource of this.launchesByWorkspaceAndSource.values()) {
      for (const arr of bySource.values()) {
        arr.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    for (const [wk, sources] of this.launchSourcesByWorkspace.entries()) {
      sources.sort((a, b) => a.label.localeCompare(b.label));
      this.launchSourcesByWorkspace.set(wk, sources);
    }

    // Tasks: workspace -> category -> source -> items
    this.taskCategoriesByWorkspace.clear();
    this.tasksByWorkspaceCategorySource.clear();
    this.taskSourcesByWorkspaceCategory.clear();

    const catsByWk: Map<string, Set<string>> = new Map();
    const sourcesByWkCat: Map<string, Map<string, Map<string, SourceRef>>> = new Map();
    const tasksByWkCatSource: Map<string, Map<string, Map<string, TaskItem[]>>> = new Map();

    this.topLevelTasksByWorkspace.clear();

    for (const t of tasks) {
      const wk = workspaceKeyFromFolder(t.workspaceFolder);
      const category = (t.category && t.category.trim()) ? t.category.trim() : undefined;

      if (!category) {
        const arr = this.topLevelTasksByWorkspace.get(wk) ?? [];
        arr.push(t);
        this.topLevelTasksByWorkspace.set(wk, arr);
        continue; // don’t put into category maps
      }
      
      if (!catsByWk.has(wk)) catsByWk.set(wk, new Set<string>());
      catsByWk.get(wk)!.add(category);

      if (!sourcesByWkCat.has(wk)) sourcesByWkCat.set(wk, new Map<string, Map<string, SourceRef>>());
      const catMap = sourcesByWkCat.get(wk)!;
      if (!catMap.has(category)) catMap.set(category, new Map<string, SourceRef>());
      catMap.get(category)!.set(t.source.id, t.source);

      if (!tasksByWkCatSource.has(wk)) tasksByWkCatSource.set(wk, new Map<string, Map<string, TaskItem[]>>());
      const catTasks = tasksByWkCatSource.get(wk)!;
      if (!catTasks.has(category)) catTasks.set(category, new Map<string, TaskItem[]>());
      const srcTasks = catTasks.get(category)!;
      if (!srcTasks.has(t.source.id)) srcTasks.set(t.source.id, []);
      srcTasks.get(t.source.id)!.push(t);
    }
    for (const [wk, arr] of this.topLevelTasksByWorkspace.entries()) {
      arr.sort((a, b) => a.label.localeCompare(b.label));
      this.topLevelTasksByWorkspace.set(wk, arr);
    }

    for (const [wk, set] of catsByWk.entries()) {
      const cats = Array.from(set).sort((a, b) => a.localeCompare(b));
      this.taskCategoriesByWorkspace.set(wk, cats);
    }

    for (const [wk, catTasks] of tasksByWkCatSource.entries()) {
      for (const srcMap of catTasks.values()) {
        for (const arr of srcMap.values()) {
          arr.sort((a, b) => a.label.localeCompare(b.label));
        }
      }
      this.tasksByWorkspaceCategorySource.set(wk, catTasks);
    }

    for (const [wk, catMap] of sourcesByWkCat.entries()) {
      const out: Map<string, SourceRef[]> = new Map();
      for (const [cat, srcMap] of catMap.entries()) {
        const srcs = Array.from(srcMap.values()).sort((a, b) => a.label.localeCompare(b.label));
        out.set(cat, srcs);
      }
      this.taskSourcesByWorkspaceCategory.set(wk, out);
    }

    // IMPORTANT: fire undefined so VS Code re-asks root items (workspaces)
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    switch (element.kind) {
      case "workspace": {
        // Start collapsed
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "betterRun.workspace";
        item.iconPath = new vscode.ThemeIcon("root-folder");
        item.tooltip = undefined;
        return item;
      }

      case "section": {
        // Start collapsed
        const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = element.section === "Launches" ? "betterRun.section.launches" : "betterRun.section.tasks";
        item.iconPath = new vscode.ThemeIcon(element.section === "Launches" ? "debug" : "checklist");
        const raw = this.storage.getNameFilter().trim();
        item.description = raw ? `filter: ${raw}` : undefined;
        item.tooltip = undefined;
        return item;
      }

      case "launch": {
        const item = new vscode.TreeItem(element.item.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "betterRun.launch";
        item.iconPath = new vscode.ThemeIcon("debug-start");
        // Left click defaults to Debug
        item.command = { command: "betterRun.debugLaunch", title: "Debug", arguments: [element.item] };
        item.tooltip = undefined;
        return item;
      }

      case "taskCategory": {
        const item = new vscode.TreeItem(element.category, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "betterRun.taskCategory";
        item.iconPath = new vscode.ThemeIcon("folder");
        item.tooltip = undefined;
        return item;
      }

      case "taskTop": {
        const item = new vscode.TreeItem(element.item.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "betterRun.task";
        item.iconPath = new vscode.ThemeIcon("play");
        item.command = { command: "betterRun.runTask", title: "Run Task", arguments: [element.item] };
        item.tooltip = undefined;
        return item;
      }

      case "task": {
        const item = new vscode.TreeItem(element.item.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "betterRun.task";
        item.iconPath = new vscode.ThemeIcon("play");
        item.command = { command: "betterRun.runTask", title: "Run Task", arguments: [element.item] };
        item.tooltip = undefined;
        return item;
      }
    }
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      if (!this.workspaces.length) await this.refresh();

      const filter = this.getFilterLower();
      if (!filter) return this.workspaces;

      // When filtered: only show workspaces that have matches in launches OR tasks
      return this.workspaces.filter((ws: WorkspaceNode) => this.workspaceHasMatches(ws.key, filter));
    }

    const filter = this.getFilterLower();

    if (element.kind === "workspace") {
      // If filter is set and this workspace has no matches, show nothing
      if (filter && !this.workspaceHasMatches(element.key, filter)) return [];

      if (!filter) {
        return [
          { kind: "section", workspaceKey: element.key, section: "Launches" },
          { kind: "section", workspaceKey: element.key, section: "Tasks" },
        ];
      }

      // Filter is active: only show sections that have matches
      const out: Node[] = [];
      if (this.workspaceHasLaunchMatches(element.key, filter)) {
        out.push({ kind: "section", workspaceKey: element.key, section: "Launches" });
      }
      if (this.workspaceHasTaskMatches(element.key, filter)) {
        out.push({ kind: "section", workspaceKey: element.key, section: "Tasks" });
      }
      return out;
    }

    // ---------- Launches ----------
    if (element.kind === "section" && element.section === "Launches") {
      const bySource: Map<string, LaunchItem[]> =
        this.launchesByWorkspaceAndSource.get(element.workspaceKey) ?? new Map<string, LaunchItem[]>();
    
      // flatten all launches in this workspace
      let all: LaunchItem[] = [];
      for (const arr of bySource.values()) all = all.concat(arr);
    
      if (filter) {
        all = all.filter((i: LaunchItem) => i.name.toLowerCase().includes(filter));
      }
    
      all.sort((a, b) => a.name.localeCompare(b.name));
      return all.map((i: LaunchItem) => ({ kind: "launch", item: i }));
    }

    // ---------- Tasks ----------
    if (element.kind === "section" && element.section === "Tasks") {
      const catTasks: Map<string, Map<string, TaskItem[]>> =
        this.tasksByWorkspaceCategorySource.get(element.workspaceKey) ??
        new Map<string, Map<string, TaskItem[]>>();
    
      // Collect top-level tasks (category undefined) across all tasks in this workspace.
      // We don’t have a dedicated map for them, so we rebuild from sources.ts data via refresh-time storage:
      // easiest: store them in a map on refresh. (See note below)
      const top = this.topLevelTasksByWorkspace.get(element.workspaceKey) ?? [];
    
      let topItems = top;
      if (filter) topItems = topItems.filter((t: TaskItem) => t.label.toLowerCase().includes(filter));
      topItems.sort((a, b) => a.label.localeCompare(b.label));
    
      const cats: string[] = this.taskCategoriesByWorkspace.get(element.workspaceKey) ?? [];
    
      // Filter categories to only those with matches
      let catNodes: Node[] = cats.map((c: string) => ({ kind: "taskCategory", workspaceKey: element.workspaceKey, category: c }));
      if (filter) {
        catNodes = cats
          .filter((c) => {
            const srcMap = catTasks.get(c) ?? new Map<string, TaskItem[]>();
            return Array.from(srcMap.values()).some((arr: TaskItem[]) =>
              arr.some((t: TaskItem) => t.label.toLowerCase().includes(filter))
            );
          })
          .map((c) => ({ kind: "taskCategory", workspaceKey: element.workspaceKey, category: c }));
      }
    
      const topNodes: Node[] = topItems.map((t: TaskItem) => ({ kind: "taskTop", item: t }));
    
      // Don’t show empty Tasks section when filtered (your workspace/section logic already helps, but keep it tight)
      return [...topNodes, ...catNodes];
    }

    if (element.kind === "taskCategory") {
      const catTasks: Map<string, Map<string, TaskItem[]>> =
        this.tasksByWorkspaceCategorySource.get(element.workspaceKey) ??
        new Map<string, Map<string, TaskItem[]>>();
    
      const srcMap: Map<string, TaskItem[]> =
        catTasks.get(element.category) ?? new Map<string, TaskItem[]>();
    
      // Flatten tasks across all sources for this category
      let all: TaskItem[] = [];
      for (const arr of srcMap.values()) {
        all = all.concat(arr);
      }
    
      if (filter) {
        all = all.filter((t: TaskItem) => t.label.toLowerCase().includes(filter));
      }
    
      all.sort((a, b) => a.label.localeCompare(b.label));
      return all.map((t: TaskItem) => ({ kind: "task", item: t }));
    }

    return [];
  }
}
