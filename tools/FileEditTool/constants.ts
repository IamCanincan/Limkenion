// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .limkenion/ folder
export const LIMKENION_FOLDER_PERMISSION_PATTERN = '/.limkenion/**'

// Permission pattern for granting session-level access to the global ~/.limkenion/ folder
export const GLOBAL_LIMKENION_FOLDER_PERMISSION_PATTERN = '~/.limkenion/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
