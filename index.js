import {
    getStringHash,
    debounce,
    waitUntilCondition,
    extractAllWords,
    isTrueBoolean,
    timestampToMoment,
} from '../../../utils.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
    activateSendButtons,
    deactivateSendButtons,
    animation_duration,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    is_send_press,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxPromptTokens,
    setExtensionPrompt,
    streamingProcessor,
    animation_easing,
} from '../../../../script.js';
import { is_group_generating, selected_group } from '../../../group-chats.js';
import { loadMovingUIState, power_user } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { debounce_timeout } from '../../../constants.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { macros, MacroCategory } from '../../../macros/macro-system.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { MacrosParser } from '/scripts/macros.js';

export { MODULE_NAME };

const MODULE_NAME = 'midterm-memory';

if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = {};
}

let lastMessageHash = null;
let lastMessageId = null;
let inApiCall = false;

/**
 * Count the number of tokens in the provided text.
 * @param {string} text Text to count tokens for
 * @param {number} padding Number of additional tokens to add to the count
 * @returns {Promise<number>} Number of tokens in the text
 */
async function countSourceTokens(text, padding = 0) {
    return await getTokenCountAsync(text, padding);
}

/**
 * Get the token budget for the raw prompt extraction.
 * @returns {Promise<number>} Token budget
 */
async function getSourceContextSize() {
    const settings = extension_settings[MODULE_NAME];
    const overrideLength = settings.overrideResponseLength;

    if (settings.source === summary_sources.openai && settings.contextSize > 0) {
        return settings.contextSize;
    }

    return getMaxPromptTokens(overrideLength);
}

const formatMemoryValue = function (value) {
    if (!value) {
        return '';
    }

    value = value.trim();

    if (extension_settings[MODULE_NAME].template) {
        return substituteParamsExtended(extension_settings[MODULE_NAME].template, { summary: value });
    } else {
        return `Summary: ${value}`;
    }
};

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

const summary_sources = {
    'main': 'main',
    'openai': 'openai',
};

const prompt_builders = {
    DEFAULT: 0,
    RAW_BLOCKING: 1,
    RAW_NON_BLOCKING: 2,
};

const defaultPrompt = `You are a User State Tracker. Maintain a concise structured log of the user's current status based ONLY on what is stated in the conversation, and optionally the previous state log if one is provided below.

=== INPUT ===
- [Previous State Log]: the existing record (if any). Use it as a base.
- [New Messages]: recent conversation to extract updates from.
- [LIVE AUTO-INJECTED TIMESTAMP (changes every turn - this is the actual current time)]:
Date: {{isodate}} | Day: {{weekday}} | Time: {{time::UTC+8}}
=== RULES ===
1. Keep entries from Previous State Log that are still true (not contradicted or outdated)
2. Update entries when new information supersedes old
3. Add new entries for new information not previously recorded
4. Remove entries that are no longer relevant (e.g. "last meal" from yesterday if today's meal is mentioned)
5. Be specific: use exact times like "5pm", not vague terms like "afternoon" or "earlier"
6. Output ONLY the updated state log, no explanations, no greetings

=== CATEGORIES TO TRACK ===
🌙 SLEEP/WAKE: When did user last wake? Last sleep attempt? Current state (awake/tired/sleepy)?
🍽 INTAKE: Last meal/drink? Hunger? Any food-related notes or cravings?
⚡ ENERGY/MOOD: Energy level, mood, emotional/mental state as described
📋 ACTIVITY: What is user currently doing? Recent activities? Plans?
⚕️ HEALTH: Any symptoms, medication, body state, Non-24 related notes?
💬 OTHER: Any other key facts about user's current situation that would be important to remember

=== FORMAT ===
Output concise bullet points under categories. Omit empty categories.

Limit: {{words}} words or less.`;
const defaultTemplate = '[Summary: {{summary}}]';

const defaultSettings = {
    enabled: true,
    SkipWIAN: false,
    source: summary_sources.main,
    apiUrl: 'http://127.0.0.1:8080',
    apiKey: '',
    model: '',
    contextSize: 0,
    prompt: defaultPrompt,
    template: defaultTemplate,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    depth: 2,
    promptWords: 200,
    promptMinWords: 25,
    promptMaxWords: 10000,
    promptWordsStep: 25,
    promptInterval: 10,
    promptMinInterval: 0,
    promptMaxInterval: 250,
    promptIntervalStep: 1,
    promptForceWords: 0,
    promptForceWordsStep: 100,
    promptMinForceWords: 0,
    promptMaxForceWords: 10000,
    overrideResponseLength: 0,
    overrideResponseLengthMin: 0,
    overrideResponseLengthMax: 4096,
    overrideResponseLengthStep: 16,
    maxMessagesPerRequest: 0,
    maxMessagesPerRequestMin: 0,
    maxMessagesPerRequestMax: 250,
    maxMessagesPerRequestStep: 1,
    prompt_builder: prompt_builders.RAW_BLOCKING,
};

function loadSettings() {
    if (Object.keys(extension_settings[MODULE_NAME]).length === 0) {
        Object.assign(extension_settings[MODULE_NAME], defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    $('#mtm_source').val(extension_settings[MODULE_NAME].source).trigger('change');
    $('#mtm_run').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#mtm_skipWIAN').prop('checked', extension_settings[MODULE_NAME].SkipWIAN).trigger('input');
    $('#mtm_prompt').val(extension_settings[MODULE_NAME].prompt);
    $('#mtm_prompt_words').val(extension_settings[MODULE_NAME].promptWords).trigger('input');
    $('#mtm_prompt_interval').val(extension_settings[MODULE_NAME].promptInterval).trigger('input');
    $('#mtm_template').val(extension_settings[MODULE_NAME].template);
    $('#mtm_depth').val(extension_settings[MODULE_NAME].depth);
    $('#mtm_role').val(extension_settings[MODULE_NAME].role);
    $(`input[name="mtm_position"][value="${extension_settings[MODULE_NAME].position}"]`).prop('checked', true);
    $('#mtm_prompt_words_force').val(extension_settings[MODULE_NAME].promptForceWords).trigger('input');
    $(`input[name="mtm_prompt_builder"][value="${extension_settings[MODULE_NAME].prompt_builder}"]`).prop('checked', true);
    $('#mtm_override_response_length').val(extension_settings[MODULE_NAME].overrideResponseLength).trigger('input');
    $('#mtm_max_messages_per_request').val(extension_settings[MODULE_NAME].maxMessagesPerRequest).trigger('input');
    $('#mtm_include_wi_scan').prop('checked', extension_settings[MODULE_NAME].scan);
    $('#mtm_api_url').val(extension_settings[MODULE_NAME].apiUrl);
    $('#mtm_api_key').val(extension_settings[MODULE_NAME].apiKey);
    $('#mtm_model').val(extension_settings[MODULE_NAME].model);
    $('#mtm_context_size').val(extension_settings[MODULE_NAME].contextSize);
    switchSourceControls(extension_settings[MODULE_NAME].source);
}

async function onPromptForceWordsAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const averageMessageWordCount = messagesWordCount / allMessages.length;
    const tokensPerWord = await countSourceTokens(allMessages.join('\n')) / messagesWordCount;
    const wordsPerToken = 1 / tokensPerWord;
    const maxPromptLengthWords = Math.round(maxPromptLength * wordsPerToken);
    // How many words should pass so that messages will start be dropped out of context;
    const wordsPerPrompt = Math.floor(maxPromptLength / tokensPerWord);
    // How many words will be needed to fit the allowance buffer
    const summaryPromptWords = extractAllWords(extension_settings[MODULE_NAME].prompt).length;
    const promptAllowanceWords = maxPromptLengthWords - extension_settings[MODULE_NAME].promptWords - summaryPromptWords;
    const averageMessagesPerPrompt = Math.floor(promptAllowanceWords / averageMessageWordCount);
    const maxMessagesPerSummary = extension_settings[MODULE_NAME].maxMessagesPerRequest || 0;
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const targetSummaryWords = (targetMessagesInPrompt * averageMessageWordCount) + (promptAllowanceWords / 4);

    console.table({
        maxPromptLength,
        maxPromptLengthWords,
        promptAllowanceWords,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        targetSummaryWords,
        wordsPerPrompt,
        wordsPerToken,
        tokensPerWord,
        messagesWordCount,
    });

    const ROUNDING = 100;
    extension_settings[MODULE_NAME].promptForceWords = Math.max(1, Math.floor(targetSummaryWords / ROUNDING) * ROUNDING);
    $('#mtm_prompt_words_force').val(extension_settings[MODULE_NAME].promptForceWords).trigger('input');
}

async function onPromptIntervalAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const messagesTokenCount = await countSourceTokens(allMessages.join('\n'));
    const tokensPerWord = messagesTokenCount / messagesWordCount;
    const averageMessageTokenCount = messagesTokenCount / allMessages.length;
    const targetSummaryTokens = Math.round(extension_settings[MODULE_NAME].promptWords * tokensPerWord);
    const promptTokens = await countSourceTokens(extension_settings[MODULE_NAME].prompt);
    const promptAllowance = maxPromptLength - promptTokens - targetSummaryTokens;
    const maxMessagesPerSummary = extension_settings[MODULE_NAME].maxMessagesPerRequest || 0;
    const averageMessagesPerPrompt = Math.floor(promptAllowance / averageMessageTokenCount);
    const targetMessagesInPrompt = maxMessagesPerSummary > 0 ? maxMessagesPerSummary : Math.max(0, averageMessagesPerPrompt);
    const adjustedAverageMessagesPerPrompt = targetMessagesInPrompt + (averageMessagesPerPrompt - targetMessagesInPrompt) / 4;

    console.table({
        maxPromptLength,
        promptAllowance,
        targetSummaryTokens,
        promptTokens,
        messagesWordCount,
        messagesTokenCount,
        tokensPerWord,
        averageMessageTokenCount,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        adjustedAverageMessagesPerPrompt,
        maxMessagesPerSummary,
    });

    const ROUNDING = 5;
    extension_settings[MODULE_NAME].promptInterval = Math.max(1, Math.floor(adjustedAverageMessagesPerPrompt / ROUNDING) * ROUNDING);

    $('#mtm_prompt_interval').val(extension_settings[MODULE_NAME].promptInterval).trigger('input');
}

function onSummarySourceChange(event) {
    const value = event.target.value;
    extension_settings[MODULE_NAME].source = value;
    switchSourceControls(value);
    saveSettingsDebounced();
}

function switchSourceControls(value) {
    $('#mtm_drawer_contents [data-summary-source], #mtm_settings [data-summary-source]').each((_, element) => {
        const source = element.dataset.summarySource.split(',').map(s => s.trim());
        $(element).toggle(source.includes(value));
    });
}

function onMemoryRunInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings[MODULE_NAME].enabled = value;
    saveSettingsDebounced();
}

function onMemorySkipWIANInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings[MODULE_NAME].SkipWIAN = value;
    saveSettingsDebounced();
}

function onMemoryPromptWordsInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].promptWords = Number(value);
    $('#mtm_prompt_words_value').text(extension_settings[MODULE_NAME].promptWords);
    saveSettingsDebounced();
}

function onMemoryPromptIntervalInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].promptInterval = Number(value);
    $('#mtm_prompt_interval_value').text(extension_settings[MODULE_NAME].promptInterval);
    saveSettingsDebounced();
}

function onMemoryPromptRestoreClick() {
    $('#mtm_prompt').val(defaultPrompt).trigger('input');
}

function onMemoryPromptInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].prompt = value;
    saveSettingsDebounced();
}

function onMemoryTemplateInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].template = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryDepthInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].depth = Number(value);
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryRoleInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].role = Number(value);
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryPositionChange(e) {
    const value = e.target.value;
    extension_settings[MODULE_NAME].position = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryIncludeWIScanInput() {
    const value = !!$(this).prop('checked');
    extension_settings[MODULE_NAME].scan = value;
    reinsertMemory();
    saveSettingsDebounced();
}

function onMemoryPromptWordsForceInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].promptForceWords = Number(value);
    $('#mtm_prompt_words_force_value').text(extension_settings[MODULE_NAME].promptForceWords);
    saveSettingsDebounced();
}

function onOverrideResponseLengthInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].overrideResponseLength = Number(value);
    $('#mtm_override_response_length_value').text(extension_settings[MODULE_NAME].overrideResponseLength);
    saveSettingsDebounced();
}

function onMaxMessagesPerRequestInput() {
    const value = $(this).val();
    extension_settings[MODULE_NAME].maxMessagesPerRequest = Number(value);
    $('#mtm_max_messages_per_request_value').text(extension_settings[MODULE_NAME].maxMessagesPerRequest);
    saveSettingsDebounced();
}

function onApiUrlInput() {
    extension_settings[MODULE_NAME].apiUrl = $(this).val();
    saveSettingsDebounced();
}

function onApiKeyInput() {
    extension_settings[MODULE_NAME].apiKey = $(this).val();
    saveSettingsDebounced();
}

function onModelInput() {
    extension_settings[MODULE_NAME].model = $(this).val();
    saveSettingsDebounced();
}

function onContextSizeInput() {
    extension_settings[MODULE_NAME].contextSize = Number($(this).val()) || 0;
    saveSettingsDebounced();
}

/**
 * Get the latest memory summary from the chat.
 * @param {ChatMessage[]} chat Chat messages
 * @returns {string} Latest memory summary or empty string
 */
function getLatestMemoryFromChat(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return '';
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) {
            return mes.extra.memory;
        }
    }

    return '';
}

/**
 * Get the index of the latest memory summary from the chat.
 * @param {ChatMessage[]} chat Chat messages
 * @returns {number} Index of the latest memory summary or -1 if not found
 */
function getIndexOfLatestChatSummary(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return -1;
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory) {
            return chat.indexOf(mes);
        }
    }

    return -1;
}

/**
 * Check if something is changed during the summarization process.
 * @param {{ groupId: any; chatId: any; characterId: any; }} context
 * @returns {boolean} True if the context has changed and the summary should be discarded
 */
function isContextChanged(context) {
    const newContext = getContext();
    if (newContext.groupId !== context.groupId
        || newContext.chatId !== context.chatId
        || (!newContext.groupId && (newContext.characterId !== context.characterId))) {
        console.log('Context changed, summary discarded');
        return true;
    }

    return false;
}

function onChatChanged() {
    const context = getContext();
    const latestMemory = getLatestMemoryFromChat(context.chat);
    setMemoryContext(latestMemory, false);
}

async function onChatEvent() {
    const settings = extension_settings[MODULE_NAME];

    // Module not enabled
    if (!settings.enabled) {
        return;
    }

    // Streaming in-progress
    if (streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    // Currently summarizing - skip
    if (inApiCall) {
        return;
    }

    const context = getContext();
    const chat = context.chat;
    // Chat can't be empty.
    if (chat.length === 0) return;

    const lastMessage = chat[chat.length - 1];

    // No new messages - do nothing
    if ((lastMessageId === chat.length && getStringHash(lastMessage.mes) === lastMessageHash)) {
        return;
    }

    // Messages has been deleted - rewrite the context with the latest available memory
    if (chat.length < lastMessageId) {
        const latestMemory = getLatestMemoryFromChat(chat);
        setMemoryContext(latestMemory, false);
    }

    // Message has been edited / regenerated - delete the saved memory
    if (chat.length
        && lastMessage.extra
        && lastMessage.extra.memory
        && lastMessageId === chat.length
        && getStringHash(lastMessage.mes) !== lastMessageHash) {
        delete lastMessage.extra.memory;
    }

    summarizeChat(context)
        .catch(console.error)
        .finally(() => {
            lastMessageId = context.chat?.length ?? null;
            lastMessageHash = getStringHash((context.chat.length && context.chat[context.chat.length - 1].mes) ?? '');
        });
}

/**
 * Forces a summary generation for the current chat.
 * @param {boolean} quiet If an informational toast should be displayed
 * @returns {Promise<string>} Summarized text
 */
async function forceSummarizeChat(quiet) {
    const settings = extension_settings[MODULE_NAME];
    const context = getContext();
    const skipWIAN = settings.SkipWIAN;

    const toast = quiet ? jQuery() : toastr.info('Summarizing chat...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    const value = settings.source === summary_sources.main
        ? await summarizeChatMain(context, true, skipWIAN)
        : await summarizeChatOpenAI(context, true);

    toastr.clear(toast);

    if (!value) {
        toastr.warning('Failed to summarize chat');
        return '';
    }

    return value;
}

/**
 * Callback for the summarize command.
 * @param {object} args Command arguments
 * @param {string} text Text to summarize
 */
async function summarizeCallback(args, text) {
    text = text.trim();

    // Summarize the current chat if no text provided
    if (!text) {
        const quiet = isTrueBoolean(args.quiet);
        return await forceSummarizeChat(quiet);
    }

    const settings = extension_settings[MODULE_NAME];
    const source = args.source || settings.source;
    const prompt = substituteParamsExtended((args.prompt || settings.prompt), { words: settings.promptWords });

    try {
        switch (source) {
            case summary_sources.main:
                return removeReasoningFromString(await generateRaw({ prompt: text, systemPrompt: prompt, responseLength: settings.overrideResponseLength }));
            case summary_sources.openai:
                return await callOpenAISummarizeAPI(prompt, text);
            default:
                toastr.warning('Invalid summarization source specified');
                return '';
        }
    } catch (error) {
        toastr.error(String(error), 'Failed to summarize text');
        console.log(error);
        return '';
    }
}

async function summarizeChat(context) {
    const settings = extension_settings[MODULE_NAME];
    switch (settings.source) {
        case summary_sources.openai:
            await summarizeChatOpenAI(context, false);
            break;
        case summary_sources.main:
            await summarizeChatMain(context, false, settings.SkipWIAN);
            break;
        default:
            break;
    }
}

/**
 * Check if the chat should be summarized based on the current conditions.
 * Return summary prompt if it should be summarized.
 * @param {any} context ST context
 * @param {boolean} force Summarize the chat regardless of the conditions
 * @returns {Promise<string>} Summary prompt or empty string
 */
async function getSummaryPromptForNow(context, force) {
    const settings = extension_settings[MODULE_NAME];

    if (settings.promptInterval === 0 && !force) {
        console.debug('Prompt interval is set to 0, skipping summarization');
        return '';
    }

    try {
        // Wait for group to finish generating
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        // Wait for the send button to be released
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('Timeout waiting for is_send_press');
        return '';
    }

    if (!context.chat.length) {
        console.debug('No messages in chat to summarize');
        return '';
    }

    if (context.chat.length < settings.promptInterval && !force) {
        console.debug(`Not enough messages in chat to summarize (chat: ${context.chat.length}, interval: ${settings.promptInterval})`);
        return '';
    }

    let messagesSinceLastSummary = 0;
    let wordsSinceLastSummary = 0;
    let conditionSatisfied = false;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].extra && context.chat[i].extra.memory) {
            break;
        }
        messagesSinceLastSummary++;
        wordsSinceLastSummary += extractAllWords(context.chat[i].mes).length;
    }

    if (messagesSinceLastSummary >= settings.promptInterval) {
        conditionSatisfied = true;
    }

    if (settings.promptForceWords && wordsSinceLastSummary >= settings.promptForceWords) {
        conditionSatisfied = true;
    }

    if (!conditionSatisfied && !force) {
        console.debug(`Summary conditions not satisfied (messages: ${messagesSinceLastSummary}, interval: ${settings.promptInterval}, words: ${wordsSinceLastSummary}, force words: ${settings.promptForceWords})`);
        return '';
    }

    console.log('Summarizing chat, messages since last summary: ' + messagesSinceLastSummary, 'words since last summary: ' + wordsSinceLastSummary);
    const prompt = substituteParamsExtended(settings.prompt, { words: settings.promptWords });

    if (!prompt) {
        console.debug('Summarization prompt is empty. Skipping summarization.');
        return '';
    }

    return prompt;
}

/**
 * Format a message send_date into a timeline timestamp.
 * @param {string} sendDate Message send date
 * @returns {string} Formatted timestamp or empty string
 */
function formatTimestamp(sendDate) {
    if (!sendDate) {
        return '';
    }

    try {
        return timestampToMoment(sendDate).format('YYYY-MM-DD HH:mm');
    } catch {
        return '';
    }
}

/**
 * Call an OpenAI-compatible endpoint (e.g. llama.cpp) to summarize the provided text.
 * @param {string} prompt System prompt for the summarization
 * @param {string} text Text to summarize
 * @returns {Promise<string>} Summarized text
 */
async function callOpenAISummarizeAPI(prompt, text) {
    const settings = extension_settings[MODULE_NAME];
    const baseUrl = settings.apiUrl.trim().replace(/\/+$/, '');
    const apiKey = settings.apiKey.trim();
    const model = settings.model.trim() || 'local-model';
    const responseLength = settings.overrideResponseLength;

    if (!baseUrl) {
        throw new Error('OpenAI API URL is not set');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
            model: model,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: text },
            ],
            temperature: 0.7,
            ...(responseLength > 0 ? { max_tokens: responseLength } : {}),
            stream: false,
        }),
    });

    if (!response.ok) {
        throw new Error(`OpenAI API call failed (${response.status} ${response.statusText})`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error('OpenAI API returned no content');
    }

    return removeReasoningFromString(content);
}

async function summarizeChatOpenAI(context, force) {
    const settings = extension_settings[MODULE_NAME];
    const prompt = await getSummaryPromptForNow(context, force);

    if (!prompt) {
        return;
    }

    const { rawPrompt, lastUsedIndex } = await getRawSummaryPrompt(context, prompt);

    if (lastUsedIndex === null || lastUsedIndex === -1) {
        if (force) {
            toastr.info('To try again, remove the latest summary.', 'No messages found to summarize');
        }

        return null;
    }

    try {
        inApiCall = true;
        const summary = await callOpenAISummarizeAPI(prompt, rawPrompt);

        if (!summary) {
            console.warn('Empty summary received');
            return;
        }

        // something changed during summarization request
        if (isContextChanged(context)) {
            return;
        }

        setMemoryContext(summary, true, lastUsedIndex);
        return summary;
    } catch (error) {
        console.error('Failed to summarize with OpenAI API', error);
        toastr.error(String(error), 'Failed to summarize text');
        return null;
    } finally {
        inApiCall = false;
    }
}

async function summarizeChatMain(context, force, skipWIAN) {
    const settings = extension_settings[MODULE_NAME];
    const prompt = await getSummaryPromptForNow(context, force);

    if (!prompt) {
        return;
    }

    console.log('sending summary prompt');
    let summary = '';
    let index = null;

    if (prompt_builders.DEFAULT === settings.prompt_builder) {
        try {
            inApiCall = true;
            /** @type {import('../../../../script.js').GenerateQuietPromptParams} */
            const params = {
                quietPrompt: prompt,
                skipWIAN: skipWIAN,
                responseLength: settings.overrideResponseLength,
            };
            summary = await generateQuietPrompt(params);
        } finally {
            inApiCall = false;
        }
    }

    if ([prompt_builders.RAW_BLOCKING, prompt_builders.RAW_NON_BLOCKING].includes(settings.prompt_builder)) {
        const lock = settings.prompt_builder === prompt_builders.RAW_BLOCKING;
        try {
            inApiCall = true;
            if (lock) {
                deactivateSendButtons();
            }

            const { rawPrompt, lastUsedIndex } = await getRawSummaryPrompt(context, prompt);

            if (lastUsedIndex === null || lastUsedIndex === -1) {
                if (force) {
                    toastr.info('To try again, remove the latest summary.', 'No messages found to summarize');
                }

                return null;
            }

            /** @type {import('../../../../script.js').GenerateRawParams} */
            const params = {
                prompt: rawPrompt,
                systemPrompt: prompt,
                responseLength: settings.overrideResponseLength,
            };
            const rawSummary = await generateRaw(params);
            summary = removeReasoningFromString(rawSummary);
            index = lastUsedIndex;
        } finally {
            inApiCall = false;
            if (lock) {
                activateSendButtons();
            }
        }
    }

    if (!summary) {
        console.warn('Empty summary received');
        return;
    }

    if (isContextChanged(context)) {
        return;
    }

    setMemoryContext(summary, true, index);
    return summary;
}

/**
 * Get the raw summarization prompt from the chat context.
 * Messages are formatted as a timeline: **Speaker** [YYYY-MM-DD HH:mm]: text
 * @param {object} context ST context
 * @param {string} prompt Summarization system prompt
 * @returns {Promise<{rawPrompt: string, lastUsedIndex: number}>} Raw summarization prompt
 */
async function getRawSummaryPrompt(context, prompt) {
    /**
     * Get the memory string from the chat buffer.
     * @param {boolean} includeSystem Include prompt into the memory string
     * @returns {string} Memory string
     */
    function getMemoryString(includeSystem) {
        const delimiter = '\n\n';
        const stringBuilder = [];
        const bufferString = chatBuffer.slice().join(delimiter);

        if (includeSystem) {
            stringBuilder.push(prompt);
        }

        if (latestSummary) {
            stringBuilder.push(latestSummary);
        }

        stringBuilder.push(bufferString);

        return stringBuilder.join(delimiter).trim();
    }

    const chat = context.chat.slice();
    const latestSummary = getLatestMemoryFromChat(chat);
    const latestSummaryIndex = getIndexOfLatestChatSummary(chat);
    chat.pop(); // We always exclude the last message from the buffer
    const chatBuffer = [];
    const PADDING = 64;
    const PROMPT_SIZE = await getSourceContextSize();
    let latestUsedMessage = null;

    for (let index = latestSummaryIndex + 1; index < chat.length; index++) {
        const message = chat[index];

        if (!message) {
            break;
        }

        if (message.is_system || !message.mes) {
            continue;
        }

        const entry = `**${message.name}** [${formatTimestamp(message.send_date)}]: ${message.mes}`;
        chatBuffer.push(entry);

        const tokens = await countSourceTokens(getMemoryString(true), PADDING);

        if (tokens > PROMPT_SIZE) {
            chatBuffer.pop();
            break;
        }

        latestUsedMessage = message;

        if (extension_settings[MODULE_NAME].maxMessagesPerRequest > 0 && chatBuffer.length >= extension_settings[MODULE_NAME].maxMessagesPerRequest) {
            break;
        }
    }

    const lastUsedIndex = context.chat.indexOf(latestUsedMessage);
    const rawPrompt = getMemoryString(false);
    return { rawPrompt, lastUsedIndex };
}

function onMemoryRestoreClick() {
    const context = getContext();
    const content = $('#mtm_contents').val();
    const reversedChat = context.chat.slice().reverse();
    reversedChat.shift();

    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.memory == content) {
            delete mes.extra.memory;
            break;
        }
    }

    const newContent = getLatestMemoryFromChat(context.chat);
    setMemoryContext(newContent, false);
}

function onMemoryContentInput() {
    const value = $(this).val();
    setMemoryContext(value, true);
}

function onMemoryPromptBuilderInput(e) {
    const value = Number(e.target.value);
    extension_settings[MODULE_NAME].prompt_builder = value;
    saveSettingsDebounced();
}

function reinsertMemory() {
    const existingValue = String($('#mtm_contents').val());
    setMemoryContext(existingValue, false);
}

/**
 * Set the summary value to the context and save it to the chat message extra.
 * @param {string} value Value of a summary
 * @param {boolean} saveToMessage Should the summary be saved to the chat message extra
 * @param {number|null} index Index of the chat message to save the summary to. If null, the pre-last message is used.
 */
function setMemoryContext(value, saveToMessage, index = null) {
    setExtensionPrompt(MODULE_NAME, formatMemoryValue(value), extension_settings[MODULE_NAME].position, extension_settings[MODULE_NAME].depth, extension_settings[MODULE_NAME].scan, extension_settings[MODULE_NAME].role);
    $('#mtm_contents').val(value);

    const summaryLog = value
        ? `Summary set to: ${value}. Position: ${extension_settings[MODULE_NAME].position}. Depth: ${extension_settings[MODULE_NAME].depth}. Role: ${extension_settings[MODULE_NAME].role}`
        : 'Summary has no content';
    console.debug(summaryLog);

    const context = getContext();
    if (saveToMessage && context.chat.length) {
        const idx = index ?? context.chat.length - 2;
        const mes = context.chat[idx < 0 ? 0 : idx];

        if (!mes.extra) {
            mes.extra = {};
        }

        mes.extra.memory = value;
        saveChatDebounced();
    }
}

async function onMemoryPreviewClick() {
    try {
        const context = getContext();
        const settings = extension_settings[MODULE_NAME];
        const prompt = substituteParamsExtended(settings.prompt, { words: settings.promptWords });
        const { rawPrompt } = await getRawSummaryPrompt(context, prompt);
        console.log(`[MidTermMemory] Raw prompt preview:\n${rawPrompt}`);
        await callGenericPopup(rawPrompt || '(empty raw prompt)', POPUP_TYPE.TEXTAREA, '', { okButton: 'Close' });
    } catch (error) {
        console.error('[MidTermMemory] Failed to build raw prompt preview', error);
        toastr.error(String(error), 'Failed to preview raw prompt');
    }
}

function doPopout(e) {
    const target = e.target;
    //repurposes the zoomed avatar template to serve as a floating div
    if ($('#mtm_popout').length === 0) {
        console.debug('did not see popout yet, creating');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="mtm_popout_header" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="mtm_popout_close" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;
        const newElement = $(template);
        newElement.attr('id', 'mtm_popout')
            .css('opacity', 0)
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        const prevSummaryBoxContents = $('#mtm_contents').val().toString(); //copy summary box before emptying
        originalElement.empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('#movingDivs').append(newElement);
        newElement.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });
        $('#mtm_drawer_contents').addClass('scrollableInnerFull');
        setMemoryContext(prevSummaryBoxContents, false); //paste prev summary box contents into popout box
        setupListeners();
        loadSettings();
        loadMovingUIState();

        dragElement(newElement);

        //setup listener for close button to restore extensions menu
        $('#mtm_popout_close').off('click').on('click', function () {
            $('#mtm_drawer_contents').removeClass('scrollableInnerFull');
            const summaryPopoutHTML = $('#mtm_drawer_contents');
            $('#mtm_popout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(summaryPopoutHTML);
                $('#mtm_popout').remove();
            });
            loadSettings();
        });
    } else {
        console.debug('saw existing popout, removing');
        $('#mtm_popout').fadeOut(animation_duration, () => { $('#mtm_popout_close').trigger('click'); });
    }
}

function setupListeners() {
    //setup shared listeners for popout and regular ext menu
    $('#mtm_restore').off('click').on('click', onMemoryRestoreClick);
    $('#mtm_contents').off('input').on('input', onMemoryContentInput);
    $('#mtm_run').off('input').on('input', onMemoryRunInput);
    $('#mtm_skipWIAN').off('input').on('input', onMemorySkipWIANInput);
    $('#mtm_source').off('change').on('change', onSummarySourceChange);
    $('#mtm_prompt_words').off('input').on('input', onMemoryPromptWordsInput);
    $('#mtm_prompt_interval').off('input').on('input', onMemoryPromptIntervalInput);
    $('#mtm_prompt').off('input').on('input', onMemoryPromptInput);
    $('#mtm_force_summarize').off('click').on('click', () => forceSummarizeChat(false));
    $('#mtm_template').off('input').on('input', onMemoryTemplateInput);
    $('#mtm_depth').off('input').on('input', onMemoryDepthInput);
    $('#mtm_role').off('input').on('input', onMemoryRoleInput);
    $('input[name="mtm_position"]').off('change').on('change', onMemoryPositionChange);
    $('#mtm_prompt_words_force').off('input').on('input', onMemoryPromptWordsForceInput);
    $('#mtm_prompt_builder_default').off('input').on('input', onMemoryPromptBuilderInput);
    $('#mtm_prompt_builder_raw_blocking').off('input').on('input', onMemoryPromptBuilderInput);
    $('#mtm_prompt_builder_raw_non_blocking').off('input').on('input', onMemoryPromptBuilderInput);
    $('#mtm_prompt_restore').off('click').on('click', onMemoryPromptRestoreClick);
    $('#mtm_prompt_interval_auto').off('click').on('click', onPromptIntervalAutoClick);
    $('#mtm_prompt_words_auto').off('click').on('click', onPromptForceWordsAutoClick);
    $('#mtm_override_response_length').off('input').on('input', onOverrideResponseLengthInput);
    $('#mtm_max_messages_per_request').off('input').on('input', onMaxMessagesPerRequestInput);
    $('#mtm_include_wi_scan').off('input').on('input', onMemoryIncludeWIScanInput);
    $('#mtm_api_url').off('input').on('input', onApiUrlInput);
    $('#mtm_api_key').off('input').on('input', onApiKeyInput);
    $('#mtm_model').off('input').on('input', onModelInput);
    $('#mtm_context_size').off('input').on('input', onContextSizeInput);
    $('#mtm_preview').off('click').on('click', onMemoryPreviewClick);
    $('#mtm_settings_block_toggle').off('click').on('click', function () {
        $('#mtm_settings_block').slideToggle(200, 'swing');
    });
}

function registerSummarizeCommand() {
    if (SlashCommandParser.commands['summarize']) {
        console.warn('[MidTermMemory] /summarize command already registered, skipping');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarize',
        callback: summarizeCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument('source', 'API to use for summarization', [ARGUMENT_TYPE.STRING], false, false, '', Object.values(summary_sources)),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt',
                description: 'prompt to use for summarization',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'suppress the toast message when summarizing the chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to summarize', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Summarizes the given text. If no text is provided, the current chat will be summarized. Can specify the source and the prompt to use.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

function registerSummaryMacro() {
    const summaryMacroHandler = () => {
        // Checking content of the UI summary box first
        const uiSummary = $('#mtm_contents').val().toString();
        if (uiSummary.trim().length > 0) {
            return uiSummary;
        }
        // Fallback to scanning the chat for the latest summary if the UI summary box is empty
        return getLatestMemoryFromChat(getContext().chat);
    };

    try {
        if (power_user.experimental_macro_engine) {
            macros.register('summary', {
                category: MacroCategory.CHAT,
                description: 'Returns the latest memory/summary from the current chat.',
                handler: () => summaryMacroHandler(),
            });
        } else {
            // TODO: Remove this when the experimental macro engine is replacing the old macro engine
            MacrosParser.registerMacro('summary',
                () => summaryMacroHandler(),
                'Returns the latest memory/summary from the current chat.');
        }
    } catch (error) {
        console.warn('[MidTermMemory] {{summary}} macro already registered, skipping', error);
    }
}

jQuery(async function () {
    async function addExtensionControls() {
        try {
            const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
            $('#extensions_settings').append(settingsHtml);
            setupListeners();
            loadSettings();
        } catch (error) {
            console.error('[MidTermMemory] Failed to load settings HTML.', error);
        }
    }

    await addExtensionControls();
    $('#mtm_popout_button').off('click').on('click', function (e) {
        doPopout(e);
        e.stopPropagation();
    });
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    for (const event of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(event, onChatEvent);
    }
    registerSummarizeCommand();
    registerSummaryMacro();
    console.log('[MidTermMemory] Extension loaded.');
});