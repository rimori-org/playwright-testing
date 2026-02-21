import { UserInfo } from '@rimori/client';

export const DEFAULT_USER_INFO: UserInfo = {
  user_id: 'test-user-id',
  mother_tongue: {
    code: 'en',
    name: 'English',
    native: 'English',
    capitalized: 'English',
    uppercase: 'ENGLISH',
  },
  target_language: {
    code: 'sv',
    name: 'Swedish',
    native: 'Svenska',
    capitalized: 'Swedish',
    uppercase: 'SWEDISH',
  },
  skill_level_reading: 'Pre-A1',
  skill_level_writing: 'Pre-A1',
  skill_level_grammar: 'Pre-A1',
  skill_level_speaking: 'Pre-A1',
  skill_level_listening: 'Pre-A1',
  skill_level_understanding: 'Pre-A1',
  learning_reason: 'growth',
  personal_interests: 'Travel and cooking',
  study_buddy: {
    id: 'buddy-1',
    name: 'Test Buddy',
    description: 'Test study buddy',
    avatarUrl: '',
    voiceId: 'alloy',
    aiPersonality: 'friendly',
  },
  study_duration: 30,
  onboarding_completed: true,
  context_menu_on_select: true,
  user_name: 'Test User',
  target_country: 'SE',
  target_city: 'Stockholm',
  user_role: 'user',
} as const;

export type DefaultUserInfo = typeof DEFAULT_USER_INFO;
