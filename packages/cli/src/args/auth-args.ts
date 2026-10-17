export const authArgs = {
  auth: {
    type: 'string',
    description: 'what the imp asks for before it wakes: token (default), basic or none',
  },
  user: { type: 'string', description: 'the basic auth user (default imp)' },
} as const;
