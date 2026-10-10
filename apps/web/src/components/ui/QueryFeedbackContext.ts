import { createContext, useContext } from 'react';

/** Shared visual state only; no ERP session or API dependency. */
export const QueryFeedbackContext = createContext(false);
export const useQueryLoadFailed = () => useContext(QueryFeedbackContext);
