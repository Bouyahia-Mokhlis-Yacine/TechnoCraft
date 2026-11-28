// The SATIM collection keeps its default name in the operator's language until someone renames it.
export const SATIM_NAME = 'Original SATIM dataset';
export const shownName = (name: string, satimLabel: string) => (name === SATIM_NAME ? satimLabel : name);
