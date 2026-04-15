import { InMemoryBackend } from '../../src/backend/in-memory-backend';
import { backendContract } from '../contract/backend-contract';

backendContract('InMemoryBackend', () => new InMemoryBackend());
