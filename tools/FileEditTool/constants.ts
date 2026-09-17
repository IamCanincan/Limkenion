// 单独放在一个文件中以避免循环依赖
export const FILE_EDIT_TOOL_NAME = 'Edit'

// 用于授予对项目 .limkenion/ 目录的会话级访问权限的权限模式
export const LIMKENION_FOLDER_PERMISSION_PATTERN = '/.limkenion/**'

// 用于授予对全局 ~/.limkenion/ 目录的会话级访问权限的权限模式
export const GLOBAL_LIMKENION_FOLDER_PERMISSION_PATTERN = '~/.limkenion/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
