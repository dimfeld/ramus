export type Intervention<DATA = undefined> = {
  /** An ID which can be passed back to the Steppable with the result. */
  id: string;
  /** A name for the source requesting this intervention. */
  source: string;
  /** A message to send to the user, if this intervention is going to be handled by the user. */
  message: string;
} & (undefined extends DATA
  ? {
      /** Additional data for this intervention. This is app-specific but might involve things such as suggested responses
       * or buttons to press.*/
      data?: DATA;
    }
  : {
      /** Additional data for this intervention. This is app-specific but might involve things such as suggested responses
       * or buttons to press.*/
      data: DATA;
    });
