import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuestionDialog } from '../components/QuestionDialog'
import type { AskQuestion } from '../types'

afterEach(cleanup)

const choiceQuestion: AskQuestion = {
  question: '用哪种方案？',
  header: '方案',
  options: [
    { label: '方案A', description: '快' },
    { label: '方案B', description: '稳' },
  ],
  multiSelect: false,
}

const formQuestion: AskQuestion = {
  question: '请补充部署信息',
  header: '部署',
  options: [],
  form: {
    fields: [
      { name: 'region', label: '区域', type: 'enum', options: ['cn-north', 'cn-south'], required: true },
      { name: 'replicas', label: '副本数', type: 'number', required: true },
      { name: 'dryRun', label: '试运行', type: 'boolean' },
      { name: 'note', label: '备注', type: 'string' },
    ],
  },
}

describe('QuestionDialog —— 普通问答', () => {
  it('选项点击后可提交，回传单选答案', () => {
    const onRespond = vi.fn()
    render(<QuestionDialog requestId="ask_1" questions={[choiceQuestion]} onRespond={onRespond} />)
    // 未选时提交禁用
    expect((screen.getByText('提交') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('方案A'))
    fireEvent.click(screen.getByText('提交'))
    expect(onRespond).toHaveBeenCalledWith('ask_1', [
      { question: '用哪种方案？', answer: '方案A' },
    ])
  })
})

describe('QuestionDialog —— elicitation 原生表单', () => {
  it('渲染类型化控件；必填未填时不能提交', () => {
    render(<QuestionDialog requestId="ask_2" questions={[formQuestion]} onRespond={vi.fn()} />)
    expect(screen.getByText('区域')).toBeTruthy()
    expect(screen.getByText('副本数')).toBeTruthy()
    // 两个必填（区域/副本数）都空 → 提交禁用
    expect((screen.getByText('提交') as HTMLButtonElement).disabled).toBe(true)
  })

  it('填完必填项后提交，答案序列化为 JSON 且带类型', () => {
    const onRespond = vi.fn()
    render(<QuestionDialog requestId="ask_3" questions={[formQuestion]} onRespond={onRespond} />)
    const selects = screen.getAllByRole('combobox')
    // 区域（enum）
    fireEvent.change(selects[0], { target: { value: 'cn-north' } })
    // 试运行（boolean 下拉，非必填）
    fireEvent.change(selects[1], { target: { value: 'true' } })
    // 副本数（number input）
    const numbers = screen.getAllByRole('spinbutton')
    fireEvent.change(numbers[0], { target: { value: '3' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onRespond).toHaveBeenCalledTimes(1)
    const payload = onRespond.mock.calls[0][1][0] as { question: string; answer: string }
    expect(payload.question).toBe('请补充部署信息')
    const parsed = JSON.parse(payload.answer)
    expect(parsed).toEqual({ region: 'cn-north', dryRun: 'true', replicas: '3' })
  })
})
