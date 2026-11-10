import type { StorybookConfig } from '@storybook/react-vite';

export default {
  framework: '@storybook/react-vite',
  stories: ['../src/gallery/**/*.stories.tsx'],
} satisfies StorybookConfig;
