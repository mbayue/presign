// Loader fixture: this module throws while it is imported.
const fail = (): never => {
  throw new Error('fixture module failed on purpose');
};

export const command = fail();
