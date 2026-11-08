// Loader fixture: a valid command that loads before broken.ts.
export const command = {
  data: { name: 'good', toJSON: () => ({ name: 'good', description: 'good' }) },
  execute: async () => {},
};
