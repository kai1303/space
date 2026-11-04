import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InviteAcceptance } from './InviteAcceptance.js';
const api=vi.hoisted(()=>({request:vi.fn()}));
const auth=vi.hoisted(()=>({getSession:vi.fn(),sendVerificationEmail:vi.fn()}));
vi.mock('../../../shared/api/request.js',()=>api);vi.mock('../../auth/auth-client.js',()=>({authClient:auth}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const preview={workspace_id:'workspace',workspace_name:'Design',kind:'email',role:'member',guest_type:'none',expires_at:'2030-01-01T00:00:00Z',email_matches:true,email_verified:true};
it('accepts only after confirmation and returns the accepted workspace',async()=>{
 api.request.mockImplementation(async(_path:string,body:unknown)=>body?{workspace_id:'workspace',already_member:false}:preview);
 const done=vi.fn();render(<InviteAcceptance token="token" onAccepted={done}/>);await screen.findByText('Join Design');expect(done).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Accept invitation'}));await waitFor(()=>expect(done).toHaveBeenCalledWith('workspace'));
});
it('blocks mismatched and unverified email accounts and explains unavailable verification delivery',async()=>{
 api.request.mockResolvedValue({...preview,email_verified:false});auth.getSession.mockResolvedValue({data:{user:{email:'new@example.test'}}});auth.sendVerificationEmail.mockResolvedValue({error:{message:'Email verification is unavailable. Configure SMTP.'}});
 render(<InviteAcceptance token="token" onAccepted={()=>{}}/>);await screen.findByText('Join Design');expect(screen.getByRole('button',{name:'Accept invitation'})).toHaveProperty('disabled',true);
 await userEvent.click(screen.getByRole('button',{name:'Send verification email'}));expect((await screen.findByRole('alert')).textContent).toContain('Email verification is unavailable');expect(auth.sendVerificationEmail).toHaveBeenCalledWith({email:'new@example.test',callbackURL:window.location.href});
});
it('expired invitations never offer acceptance',async()=>{
 api.request.mockRejectedValue(new Error('invitation_unavailable'));render(<InviteAcceptance token="expired" onAccepted={()=>{}}/>);
 expect((await screen.findByRole('alert')).textContent).toContain('expired');expect(screen.queryByRole('button',{name:'Accept invitation'})).toBeNull();
});
