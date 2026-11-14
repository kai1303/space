import { act,cleanup,fireEvent,render,screen } from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {WorkspaceAddress} from './WorkspaceAddress.js';

const {lookup,verify}=vi.hoisted(()=>({lookup:vi.fn(),verify:vi.fn()}));
vi.mock('../../shared/api/request.js',()=>({request:lookup}));
vi.mock('../auth/auth-client.js',()=>({authClient:{sendVerificationEmail:verify}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});

it('keeps verification available during lookup and lets Join become available independently',async()=>{
 let fail!:(reason:Error)=>void, finish!:(value:unknown)=>void;
 lookup.mockReturnValue(new Promise((_resolve,reject)=>{fail=reject;}));
 verify.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
 render(<WorkspaceAddress slug="studio" email="alex@example.com"/>);
 expect(screen.getByRole('button',{name:'Checking workspace access…'})).toHaveProperty('disabled',true);
 const button=screen.getByRole('button',{name:'Verify email address'});
 fireEvent.click(button);
 expect(verify).toHaveBeenCalledOnce();
 await act(async()=>fail(new Error('not_found')));
 expect(screen.getByRole('button',{name:'Join workspace'})).toHaveProperty('disabled',false);
 expect(button.getAttribute('aria-busy')).toBe('true');
 await act(async()=>finish({error:null}));
 expect(screen.getByRole('status').textContent).toContain('Check your email');
});
