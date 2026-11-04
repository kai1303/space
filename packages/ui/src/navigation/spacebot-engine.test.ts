import {expect,it} from 'vitest';
import {BotEngine,shapes,expressions,states} from './spacebot-engine.js';
it('retains all inspected shape, face and pose presets with finite SVG geometry',()=>{
 expect(shapes).toHaveLength(8);expect(expressions).toHaveLength(16);expect(states).toHaveLength(15);
 for(const shape of shapes)for(const state of states){
  const engine=new BotEngine(100,state.id,shape.radii,expressions[1]);
  for(const time of [.35,.8,1.6]){
   const frame=engine.sample(time);expect(frame.bodyPath).toMatch(/^M/);const finite=(value:unknown):void=>{if(typeof value==='number')expect(Number.isFinite(value)).toBe(true);else if(value&&typeof value==='object')Object.values(value).forEach(finite);};finite(frame);
   for(const eye of frame.eyes)expect(eye.matrix).toMatch(/^matrix\(/);
  }
 }
});
it('preserves the source easing and interrupted shape/pose transitions',()=>{
 const engine=new BotEngine(100,'idle',shapes[0].radii,expressions[1]);
 const before=engine.sample(.35);engine.setShape(shapes[2].radii,.35);
 expect(engine.sample(.35).bodyPath).toBe(before.bodyPath);
 expect(engine.sample(.8).bodyPath).not.toBe(before.bodyPath);
 engine.setState('wink',.8);const midway=engine.sample(.9);engine.setState('orbit',.9);
 expect(engine.sample(.9).bodyPath).toBe(midway.bodyPath);
});
