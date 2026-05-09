// Lambda entry: SFN ListTenants task — returns tenant UUID strings for Map iteration.

export const handler = async (): Promise<{ tenantIds: string[] }> => {
  return { tenantIds: [] };
};
