// Motion restores scroll after measuring auto heights; jsdom has no scrollTo.
if (typeof window !== 'undefined') window.scrollTo = () => {};
