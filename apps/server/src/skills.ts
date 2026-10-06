import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSkills, type LoadSkillsResult, type Skill } from '@earendil-works/pi-coding-agent';

/** Repository skills precede the user's ordinary files. Pi owns parsing,
 * canonical-path deduplication and first-name-wins collision diagnostics. */
export interface SkillLoaderOptions {
  sourceDirectory: string;
  /** Defaults to MIRA_HOME or ~/.mira. It is not Pi's agent/config directory. */
  miraHome?: string;
  /** Changed diagnostics only. Defaults to structured terminal warnings. */
  onDiagnostics?: (diagnostics: LoadSkillsResult['diagnostics']) => void;
}

export function createSkillLoader(options: SkillLoaderOptions): (signal: AbortSignal) => Promise<Skill[]> {
  const sourceDirectory = path.resolve(options.sourceDirectory);
  const miraHome = path.resolve(options.miraHome ?? process.env['MIRA_HOME'] ?? path.join(os.homedir(), '.mira'));
  const roots = [path.join(sourceDirectory, 'skills'), path.join(miraHome, 'skills')];
  let previousDiagnostics = '[]';
  return async signal => {
    signal.throwIfAborted();
    const skillPaths: string[] = [];
    // An absent optional directory is an empty catalog, including when the user
    // has never created ~/.mira/skills. Check again at the next natural request.
    for (const root of roots) {
      try { await stat(root); skillPaths.push(root); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    signal.throwIfAborted();
    const result = loadSkills({ cwd: sourceDirectory, agentDir: miraHome, skillPaths, includeDefaults: false });
    signal.throwIfAborted();
    const diagnostics = JSON.stringify(result.diagnostics);
    if (diagnostics !== previousDiagnostics) {
      previousDiagnostics = diagnostics;
      if (options.onDiagnostics) options.onDiagnostics(result.diagnostics);
      // Parser errors can embed file excerpts. Keep terminal diagnostics useful
      // without copying skill contents (or accidentally pasted secrets) to logs.
      else for (const diagnostic of result.diagnostics) console.warn('Mira skill diagnostic:', JSON.stringify({
        type: diagnostic.type, path: diagnostic.path,
        ...(diagnostic.collision ? { collision: diagnostic.collision } : { message: 'Invalid or unreadable skill metadata; inspect this file' }),
      }));
    }
    return result.skills;
  };
}
