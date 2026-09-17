export const DESCRIPTION =
  '替换 Jupyter 笔记本中特定单元格的内容。'
export const PROMPT = `用新的源代码完全替换 Jupyter 笔记本（.ipynb 文件）中特定单元格的内容。Jupyter 笔记本是结合了代码、文本和可视化内容的交互式文档，常用于数据分析和科学计算。notebook_path 参数必须是绝对路径，而非相对路径。cell_number 从 0 开始计数。使用 edit_mode=insert 可在 cell_number 指定的索引处添加新单元格。使用 edit_mode=delete 可删除 cell_number 指定位置的单元格。`
