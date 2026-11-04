import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {DestinationTransition} from './DestinationTransition.js';
const preference=vi.hoisted(()=>({reduced:false}));
vi.mock('motion/react',async original=>({...await original<typeof import('motion/react')>(),useReducedMotion:()=>preference.reduced}));
afterEach(()=>{cleanup();preference.reduced=false;});
it('keeps Home mounted while its workspace changes',()=>{
 const view=render(<DestinationTransition destination="Home" scope="one"><button>First workspace</button></DestinationTransition>);
 const home=screen.getByRole('region',{name:'Home page'});
 view.rerender(<DestinationTransition destination="Home" scope="two"><button>Second workspace</button></DestinationTransition>);
 expect(screen.getByRole('region',{name:'Home page'})).toBe(home);
 expect(screen.getByRole('button',{name:'Second workspace'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'First workspace'})).toBeNull();
});
it('keeps the active page mounted on updates and makes its outgoing content inert',async()=>{
 const view=render(<DestinationTransition destination="Home"><button>Home content</button></DestinationTransition>);
 const home=screen.getByRole('region',{name:'Home page'});
 view.rerender(<DestinationTransition destination="Home"><button>Updated Home content</button></DestinationTransition>);
 expect(screen.getByRole('region',{name:'Home page'})).toBe(home);
 view.rerender(<DestinationTransition destination="DMs"><button>DM content</button></DestinationTransition>);
 expect(home.hasAttribute('inert')).toBe(true);expect(home.getAttribute('aria-hidden')).toBe('true');
 const dms=await screen.findByRole('region',{name:'DMs page'});
 await waitFor(()=>expect(dms.style.opacity).toBe('1'));
 view.rerender(<DestinationTransition destination="DMs"><button>Updated DM content</button></DestinationTransition>);
 expect(screen.getByRole('region',{name:'DMs page'})).toBe(dms);expect(dms.style.opacity).toBe('1');
 expect(dms.style.transform).not.toMatch(/translate|scale/);
});
it('shows the destination immediately with reduced motion',async()=>{
 preference.reduced=true;
 const view=render(<DestinationTransition destination="Home">Home</DestinationTransition>);
 view.rerender(<DestinationTransition destination="Activity">Activity</DestinationTransition>);
 const page=await screen.findByRole('region',{name:'Activity page'});
 await waitFor(()=>expect(page.style.opacity).toBe('1'));
 expect(page.style.transform).not.toMatch(/translate|scale/);
});
