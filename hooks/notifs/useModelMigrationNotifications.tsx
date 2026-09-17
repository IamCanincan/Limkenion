import type { Notification } from 'src/context/notifications.js';
import { type GlobalConfig } from 'src/utils/config.js';
import { useStartupNotification } from './useStartupNotification.js';

// 模型迁移完成后的一次性提示。
//
// **本构建里这张表是空的** —— 上游那套模型版本迁移、以及写迁移时间戳的逻辑，
// 已在去痕迹工程中整体删除。没有任何东西会再写 `*MigrationTimestamp`，
// 所以这些提示永远不会触发。
// 保留 hook 本身是为了不动 `screens/REPL.tsx` 的调用点。
const MIGRATIONS: ((c: GlobalConfig) => Notification | undefined)[] = [];

export function useModelMigrationNotifications() {
  useStartupNotification(_temp);
}

function _temp() {
  return null;
}
