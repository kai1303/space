import type { Meta, StoryObj } from '@storybook/react-vite';
import { AgentResponsePreview } from './AgentResponsePreview.js';

const meta = {
  title: 'Agents/Response streaming',
  component: AgentResponsePreview,
} satisfies Meta<typeof AgentResponsePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FinalAnswer: Story = { args: { phase: 'final_answer' } };
export const Commentary: Story = { args: { phase: 'commentary' } };
