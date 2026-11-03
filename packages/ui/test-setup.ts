// Motion restores scroll after measuring auto heights; jsdom has no scrollTo.
window.scrollTo = () => {};
