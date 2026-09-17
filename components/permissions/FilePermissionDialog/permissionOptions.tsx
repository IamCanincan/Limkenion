import { homedir } from 'os';
import { basename, join, sep } from 'path';
import React, { type ReactNode } from 'react';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import { Text } from '../../../ink.js';
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { expandPath, getDirectoryForPath } from '../../../utils/path.js';
import { normalizeCaseForComparison, pathInAllowedWorkingPath } from '../../../utils/permissions/filesystem.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
/**
 * Check if a path is within the project's .limkenion/ folder.
 * This is used to determine whether to show the special ".limkenion folder" permission option.
 */
export function isInLimkenionFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath);
  const limkenionFolderPath = expandPath(`${getOriginalCwd()}/.limkenion`);

  // Check if the path is within the project's .limkenion folder
  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath);
  const normalizedLimkenionFolderPath = normalizeCaseForComparison(limkenionFolderPath);

  // Path must start with the .limkenion folder path (and be inside it, not just the folder itself)
  return normalizedAbsolutePath.startsWith(normalizedLimkenionFolderPath + sep.toLowerCase()) ||
  // Also match case where sep is / on posix systems
  normalizedAbsolutePath.startsWith(normalizedLimkenionFolderPath + '/');
}

/**
 * Check if a path is within the global ~/.limkenion/ folder.
 * This is used to determine whether to show the special ".limkenion folder" permission option
 * for files in the user's home directory.
 */
export function isInGlobalLimkenionFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath);
  const globalLimkenionFolderPath = join(homedir(), '.limkenion');
  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath);
  const normalizedGlobalLimkenionFolderPath = normalizeCaseForComparison(globalLimkenionFolderPath);
  return normalizedAbsolutePath.startsWith(normalizedGlobalLimkenionFolderPath + sep.toLowerCase()) || normalizedAbsolutePath.startsWith(normalizedGlobalLimkenionFolderPath + '/');
}
export type PermissionOption = {
  type: 'accept-once';
} | {
  type: 'accept-session';
  scope?: 'limkenion-folder' | 'global-limkenion-folder';
} | {
  type: 'reject';
};
export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption;
};
export type FileOperationType = 'read' | 'write' | 'create';
export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false
}: {
  filePath: string;
  toolPermissionContext: ToolPermissionContext;
  operationType?: FileOperationType;
  onRejectFeedbackChange?: (value: string) => void;
  onAcceptFeedbackChange?: (value: string) => void;
  yesInputMode?: boolean;
  noInputMode?: boolean;
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = [];
  const modeCycleShortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');

  // When in input mode, show input field
  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: 'and tell Limkenion what to do next',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: {
        type: 'accept-once'
      }
    });
  } else {
    options.push({
      label: 'Yes',
      value: 'yes',
      option: {
        type: 'accept-once'
      }
    });
  }
  const inAllowedPath = pathInAllowedWorkingPath(filePath, toolPermissionContext);

  // Check if this is a .limkenion/ folder path (project or global)
  const inLimkenionFolder = isInLimkenionFolder(filePath);
  const inGlobalLimkenionFolder = isInGlobalLimkenionFolder(filePath);

  // Option 2: For .limkenion/ folder, show special option instead of generic session option
  // Note: Session-level options are always shown since they only affect in-memory state,
  // not persisted settings. The allowManagedPermissionRulesOnly setting only restricts
  // persisted permission rules.
  if ((inLimkenionFolder || inGlobalLimkenionFolder) && operationType !== 'read') {
    options.push({
      label: 'Yes, and allow Limkenion to edit its own settings for this session',
      value: 'yes-limkenion-folder',
      option: {
        type: 'accept-session',
        scope: inGlobalLimkenionFolder ? 'global-limkenion-folder' : 'limkenion-folder'
      }
    });
  } else {
    // Option 2: Allow all changes/reads during session
    let sessionLabel: ReactNode;
    if (inAllowedPath) {
      // Inside working directory
      if (operationType === 'read') {
        sessionLabel = 'Yes, during this session';
      } else {
        sessionLabel = <Text>
            Yes, allow all edits during this session{' '}
            <Text bold>({modeCycleShortcut})</Text>
          </Text>;
      }
    } else {
      // Outside working directory - include directory name
      const dirPath = getDirectoryForPath(filePath);
      const dirName = basename(dirPath) || 'this directory';
      if (operationType === 'read') {
        sessionLabel = <Text>
            Yes, allow reading from <Text bold>{dirName}/</Text> during this
            session
          </Text>;
      } else {
        sessionLabel = <Text>
            Yes, allow all edits in <Text bold>{dirName}/</Text> during this
            session <Text bold>({modeCycleShortcut})</Text>
          </Text>;
      }
    }
    options.push({
      label: sessionLabel,
      value: 'yes-session',
      option: {
        type: 'accept-session'
      }
    });
  }

  // When in input mode, show input field for reject
  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: 'and tell Limkenion what to do differently',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: {
        type: 'reject'
      }
    });
  } else {
    // Not in input mode - simple option
    options.push({
      label: 'No',
      value: 'no',
      option: {
        type: 'reject'
      }
    });
  }
  return options;
}