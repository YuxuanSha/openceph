#!/usr/bin/env node
export declare function getBuiltinTentaclesDir(): string;
export declare function initBuiltinTentacles(targetSkillsDir: string, skipList?: string[]): Promise<void>;
export declare function upgradeBuiltinTentacles(targetSkillsDir: string, skipList?: string[]): Promise<void>;
