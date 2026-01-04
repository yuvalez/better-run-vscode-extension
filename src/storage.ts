import * as vscode from "vscode";

const LAST_RUN_ID_KEY = "betterRun.lastRunId";
const NAME_FILTER_KEY = "betterRun.nameFilter";

export class Storage {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async setLastRunId(id: string): Promise<void> {
    await this.context.globalState.update(LAST_RUN_ID_KEY, id);
  }

  getLastRunId(): string | undefined {
    return this.context.globalState.get<string>(LAST_RUN_ID_KEY);
  }

  async setNameFilter(value: string): Promise<void> {
    await this.context.globalState.update(NAME_FILTER_KEY, value);
  }

  getNameFilter(): string {
    return this.context.globalState.get<string>(NAME_FILTER_KEY) ?? "";
  }
}
