import * as vscode from "vscode";
import { loadLaunchesAndTasks, LaunchItem, TaskItem, NotebookItem, SourceRef } from "./sources";
import { Storage } from "./storage";

// Helper to get output channel for debugging
function getOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel("Better Run");
}

type WorkspaceNode = {
  kind: "workspace";
  key: string;
  name: string;
  workspaceFolder?: vscode.WorkspaceFolder;
};

type Node =
  | WorkspaceNode
  | { kind: "section"; workspaceKey: string; section: "Launches" | "Tasks" | "Notebooks" }
  | { kind: "launchCategory"; workspaceKey: string; category: string }
  | { kind: "launchSource"; workspaceKey: string; sourceId: string; sourceLabel: string }
  | { kind: "launchTop"; item: LaunchItem }
  | { kind: "launch"; item: LaunchItem }
  | { kind: "taskCategory"; workspaceKey: string; category: string }
  | { kind: "taskTop"; item: TaskItem }
  | { kind: "task"; item: TaskItem }
  | { kind: "notebook"; item: NotebookItem };

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

  // workspaceKey -> top-level launches (no category)
  private topLevelLaunchesByWorkspace: Map<string, LaunchItem[]> = new Map();

  // workspaceKey -> categories[]
  private launchCategoriesByWorkspace: Map<string, string[]> = new Map();

  // workspaceKey -> category -> sourceId -> launches[]
  private launchesByWorkspaceCategorySource: Map<string, Map<string, Map<string, LaunchItem[]>>> = new Map();

  // workspaceKey -> category -> sources[]
  private launchSourcesByWorkspaceCategory: Map<string, Map<string, SourceRef[]>> = new Map();

  // workspaceKey -> categories[]
  private taskCategoriesByWorkspace: Map<string, string[]> = new Map();

  // workspaceKey -> category -> sourceId -> tasks[]
  private tasksByWorkspaceCategorySource: Map<string, Map<string, Map<string, TaskItem[]>>> = new Map();

  // workspaceKey -> category -> sources[]
  private taskSourcesByWorkspaceCategory: Map<string, Map<string, SourceRef[]>> = new Map();

  // workspaceKey -> notebooks[]
  private notebooksByWorkspace: Map<string, NotebookItem[]> = new Map();

  // Track running launches and tasks for loading state
  private runningLaunches: Set<string> = new Set(); // launch id
  private runningTasks: Set<string> = new Set(); // task id

  constructor(private readonly storage: Storage) {}

  setLaunchRunning(launchId: string, running: boolean): void {
    if (running) {
      this.runningLaunches.add(launchId);
    } else {
      this.runningLaunches.delete(launchId);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  setTaskRunning(taskId: string, running: boolean): void {
    if (running) {
      this.runningTasks.add(taskId);
    } else {
      this.runningTasks.delete(taskId);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  private getFilterLower(): string {
    return this.storage.getNameFilter().trim().toLowerCase();
  }

  private workspaceHasMatches(workspaceKey: string, filterLower: string): boolean {
    if (!filterLower) return true;

    const hasLaunchMatch = this.workspaceHasLaunchMatches(workspaceKey, filterLower);

    const catTasks: Map<string, Map<string, TaskItem[]>> =
      this.tasksByWorkspaceCategorySource.get(workspaceKey) ?? new Map<string, Map<string, TaskItem[]>>();

    const hasTaskMatch = Array.from(catTasks.values()).some((srcMap: Map<string, TaskItem[]>) =>
      Array.from(srcMap.values()).some((arr: TaskItem[]) =>
        arr.some((t: TaskItem) => t.label.toLowerCase().includes(filterLower))
      )
    );

    const notebooks = this.notebooksByWorkspace.get(workspaceKey) ?? [];
    const hasNotebookMatch = notebooks.some((n: NotebookItem) => n.name.toLowerCase().includes(filterLower));

    return hasLaunchMatch || hasTaskMatch || hasNotebookMatch;
  }

  private workspaceHasLaunchMatches(workspaceKey: string, filterLower: string): boolean {
    if (!filterLower) return true;

    // Check top-level launches
    const topLaunches = this.topLevelLaunchesByWorkspace.get(workspaceKey) ?? [];
    if (topLaunches.some((i: LaunchItem) => i.name.toLowerCase().includes(filterLower))) {
      return true;
    }

    // Check categorized launches
    const catLaunches: Map<string, Map<string, LaunchItem[]>> =
      this.launchesByWorkspaceCategorySource.get(workspaceKey) ?? new Map<string, Map<string, LaunchItem[]>>();

    return Array.from(catLaunches.values()).some((srcMap: Map<string, LaunchItem[]>) =>
      Array.from(srcMap.values()).some((arr: LaunchItem[]) =>
        arr.some((i: LaunchItem) => i.name.toLowerCase().includes(filterLower))
      )
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
    const { launchSources, launches, taskSources, tasks, notebooks } = await loadLaunchesAndTasks();

    // Workspaces (plus optional User)
    const ws: WorkspaceNode[] = (vscode.workspace.workspaceFolders ?? []).map((wf) => ({
      kind: "workspace",
      key: workspaceKeyFromFolder(wf),
      name: wf.name,
      workspaceFolder: wf,
    }));

    const hasUser = launchSources.some((s) => !s.workspaceFolder) || taskSources.some((s) => !s.workspaceFolder) || notebooks.some((n) => n.isLocal);
    this.workspaces = [...ws];
    if (hasUser) {
      this.workspaces.push({ kind: "workspace", key: USER_WORKSPACE_KEY, name: "Local" });
    }

    // Organize notebooks by workspace
    this.notebooksByWorkspace.clear();
    for (const nb of notebooks) {
      // Local notebooks go to USER_WORKSPACE_KEY, others to their workspace folder
      const wk = nb.isLocal ? USER_WORKSPACE_KEY : workspaceKeyFromFolder(nb.workspaceFolder);
      const arr = this.notebooksByWorkspace.get(wk) ?? [];
      arr.push(nb);
      this.notebooksByWorkspace.set(wk, arr);
    }
    for (const [wk, arr] of this.notebooksByWorkspace.entries()) {
      arr.sort((a: NotebookItem, b: NotebookItem) => a.name.localeCompare(b.name));
      this.notebooksByWorkspace.set(wk, arr);
    }
    
    // Debug: log notebook organization
    const outputChannel = vscode.window.createOutputChannel("Better Run");
    for (const [wk, arr] of this.notebooksByWorkspace.entries()) {
      outputChannel.appendLine(`Better Run: Workspace ${wk} has ${arr.length} notebooks`);
    }

    // Launches: workspace -> category -> source -> items (similar to tasks)
    this.launchSourcesByWorkspace.clear();
    this.launchesByWorkspaceAndSource.clear();
    this.topLevelLaunchesByWorkspace.clear();
    this.launchCategoriesByWorkspace.clear();
    this.launchesByWorkspaceCategorySource.clear();
    this.launchSourcesByWorkspaceCategory.clear();

    const launchCatsByWk: Map<string, Set<string>> = new Map();
    const launchSourcesByWkCat: Map<string, Map<string, Map<string, SourceRef>>> = new Map();
    const launchesByWkCatSource: Map<string, Map<string, Map<string, LaunchItem[]>>> = new Map();

    for (const source of launchSources) {
      const wk = workspaceKeyFromFolder(source.workspaceFolder);
      const list: SourceRef[] = this.launchSourcesByWorkspace.get(wk) ?? [];
      list.push(source);
      this.launchSourcesByWorkspace.set(wk, list);
    }

    for (const l of launches) {
      const wk = workspaceKeyFromFolder(l.workspaceFolder);
      const category = (l.category && l.category.trim()) ? l.category.trim() : undefined;

      if (!category) {
        // Top-level launch (no category)
        const arr = this.topLevelLaunchesByWorkspace.get(wk) ?? [];
        arr.push(l);
        this.topLevelLaunchesByWorkspace.set(wk, arr);
        continue;
      }

      // Categorized launch
      if (!launchCatsByWk.has(wk)) launchCatsByWk.set(wk, new Set<string>());
      launchCatsByWk.get(wk)!.add(category);

      if (!launchSourcesByWkCat.has(wk)) launchSourcesByWkCat.set(wk, new Map<string, Map<string, SourceRef>>());
      const catMap = launchSourcesByWkCat.get(wk)!;
      if (!catMap.has(category)) catMap.set(category, new Map<string, SourceRef>());
      catMap.get(category)!.set(l.source.id, l.source);

      if (!launchesByWkCatSource.has(wk)) launchesByWkCatSource.set(wk, new Map<string, Map<string, LaunchItem[]>>());
      const catLaunches = launchesByWkCatSource.get(wk)!;
      if (!catLaunches.has(category)) catLaunches.set(category, new Map<string, LaunchItem[]>());
      const srcLaunches = catLaunches.get(category)!;
      if (!srcLaunches.has(l.source.id)) srcLaunches.set(l.source.id, []);
      srcLaunches.get(l.source.id)!.push(l);
    }

    // Sort top-level launches
    for (const [wk, arr] of this.topLevelLaunchesByWorkspace.entries()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
      this.topLevelLaunchesByWorkspace.set(wk, arr);
    }

    // Sort categories
    for (const [wk, set] of launchCatsByWk.entries()) {
      const cats = Array.from(set).sort((a, b) => a.localeCompare(b));
      this.launchCategoriesByWorkspace.set(wk, cats);
    }

    // Sort launches within categories
    for (const [wk, catLaunches] of launchesByWkCatSource.entries()) {
      for (const srcMap of catLaunches.values()) {
        for (const arr of srcMap.values()) {
          arr.sort((a, b) => a.name.localeCompare(b.name));
        }
      }
      this.launchesByWorkspaceCategorySource.set(wk, catLaunches);
    }

    // Organize sources by category
    for (const [wk, catMap] of launchSourcesByWkCat.entries()) {
      const out: Map<string, SourceRef[]> = new Map();
      for (const [cat, srcMap] of catMap.entries()) {
        const srcs = Array.from(srcMap.values()).sort((a, b) => a.label.localeCompare(b.label));
        out.set(cat, srcs);
      }
      this.launchSourcesByWorkspaceCategory.set(wk, out);
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

      case "launchCategory": {
        const item = new vscode.TreeItem(element.category, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "betterRun.launchCategory";
        item.iconPath = new vscode.ThemeIcon("folder");
        item.tooltip = undefined;
        return item;
      }

      case "launchSource": {
        const item = new vscode.TreeItem(element.sourceLabel, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "betterRun.launchSource";
        item.iconPath = new vscode.ThemeIcon("file");
        item.tooltip = undefined;
        return item;
      }

      case "launchTop": {
        const item = new vscode.TreeItem(element.item.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "betterRun.launch";
        const isRunning = this.runningLaunches.has(element.item.id);
        item.iconPath = isRunning 
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("debug-start");
        // Don't set command - clicking should not trigger, only the buttons should
        item.tooltip = isRunning 
          ? `Debugging: ${element.item.name}` 
          : `${element.item.name}\nRight-click for Debug/Run options`;
        return item;
      }

      case "launch": {
        const item = new vscode.TreeItem(element.item.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "betterRun.launch";
        const isRunning = this.runningLaunches.has(element.item.id);
        item.iconPath = isRunning 
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("symbol-event"); // Neutral icon that doesn't suggest clickability
        // Don't set command - clicking should not trigger, only the inline buttons should
        item.tooltip = isRunning 
          ? `Debugging: ${element.item.name}` 
          : `${element.item.name}\nUse the buttons on the right to Debug/Run`;
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
        const isRunning = this.runningTasks.has(element.item.id);
        item.iconPath = isRunning 
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("symbol-method"); // Neutral icon that doesn't suggest clickability
        // Don't set command - clicking should not trigger, only the inline button should
        item.tooltip = isRunning 
          ? `Running: ${element.item.label}` 
          : `${element.item.label}\nUse the button on the right to Run`;
        return item;
      }

      case "task": {
        const item = new vscode.TreeItem(element.item.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "betterRun.task";
        const isRunning = this.runningTasks.has(element.item.id);
        item.iconPath = isRunning 
          ? new vscode.ThemeIcon("loading~spin")
          : new vscode.ThemeIcon("symbol-method"); // Neutral icon that doesn't suggest clickability
        // Don't set command - clicking should not trigger, only the inline button should
        item.tooltip = isRunning 
          ? `Running: ${element.item.label}` 
          : `${element.item.label}\nUse the button on the right to Run`;
        return item;
      }

      case "notebook": {
        const item = new vscode.TreeItem(element.item.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "betterRun.notebook";
        item.iconPath = new vscode.ThemeIcon("notebook");
        item.command = { command: "betterRun.openNotebook", title: "Open Notebook", arguments: [element.item] };
        const location = element.item.isLocal ? "Local" : element.item.workspaceFolder?.name;
        item.tooltip = `${element.item.name}\n${location ? `Location: ${location}` : ''}\nClick to open`;
        item.resourceUri = element.item.uri;
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

      const workspaceNotebooks = this.notebooksByWorkspace.get(element.key) ?? [];
      const hasNotebooks = workspaceNotebooks.length > 0;

      if (!filter) {
        const sections: Node[] = [
          { kind: "section", workspaceKey: element.key, section: "Launches" },
          { kind: "section", workspaceKey: element.key, section: "Tasks" },
        ];
        if (hasNotebooks) {
          sections.push({ kind: "section", workspaceKey: element.key, section: "Notebooks" });
        }
        return sections;
      }

      // Filter is active: only show sections that have matches
      const out: Node[] = [];
      if (this.workspaceHasLaunchMatches(element.key, filter)) {
        out.push({ kind: "section", workspaceKey: element.key, section: "Launches" });
      }
      if (this.workspaceHasTaskMatches(element.key, filter)) {
        out.push({ kind: "section", workspaceKey: element.key, section: "Tasks" });
      }
      const hasNotebookMatches = workspaceNotebooks.some((n: NotebookItem) => n.name.toLowerCase().includes(filter));
      if (hasNotebookMatches) {
        out.push({ kind: "section", workspaceKey: element.key, section: "Notebooks" });
      }
      return out;
    }

    // ---------- Launches ----------
    if (element.kind === "section" && element.section === "Launches") {
      const catLaunches: Map<string, Map<string, LaunchItem[]>> =
        this.launchesByWorkspaceCategorySource.get(element.workspaceKey) ??
        new Map<string, Map<string, LaunchItem[]>>();
    
      // Collect top-level launches (category undefined)
      const top = this.topLevelLaunchesByWorkspace.get(element.workspaceKey) ?? [];
    
      let topItems = top;
      if (filter) topItems = topItems.filter((i: LaunchItem) => i.name.toLowerCase().includes(filter));
      topItems.sort((a, b) => a.name.localeCompare(b.name));
    
      const cats: string[] = this.launchCategoriesByWorkspace.get(element.workspaceKey) ?? [];
    
      // Filter categories to only those with matches
      let catNodes: Node[] = cats.map((c: string) => ({ kind: "launchCategory", workspaceKey: element.workspaceKey, category: c }));
      if (filter) {
        catNodes = cats
          .filter((c) => {
            const srcMap = catLaunches.get(c) ?? new Map<string, LaunchItem[]>();
            return Array.from(srcMap.values()).some((arr: LaunchItem[]) =>
              arr.some((i: LaunchItem) => i.name.toLowerCase().includes(filter))
            );
          })
          .map((c) => ({ kind: "launchCategory", workspaceKey: element.workspaceKey, category: c }));
      }
    
      const topNodes: Node[] = topItems.map((i: LaunchItem) => ({ kind: "launchTop", item: i }));
    
      return [...topNodes, ...catNodes];
    }

    if (element.kind === "launchCategory") {
      const catLaunches: Map<string, Map<string, LaunchItem[]>> =
        this.launchesByWorkspaceCategorySource.get(element.workspaceKey) ??
        new Map<string, Map<string, LaunchItem[]>>();
    
      const srcMap: Map<string, LaunchItem[]> =
        catLaunches.get(element.category) ?? new Map<string, LaunchItem[]>();
    
      // Flatten all launches across all sources for this category
      let all: LaunchItem[] = [];
      for (const arr of srcMap.values()) {
        all = all.concat(arr);
      }
    
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

    // ---------- Notebooks ----------
    if (element.kind === "section" && element.section === "Notebooks") {
      const notebooks = this.notebooksByWorkspace.get(element.workspaceKey) ?? [];
    
      let filtered = notebooks;
      if (filter) {
        filtered = notebooks.filter((n: NotebookItem) => n.name.toLowerCase().includes(filter));
      }
    
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      return filtered.map((n: NotebookItem) => ({ kind: "notebook", item: n }));
    }

    return [];
  }
}
